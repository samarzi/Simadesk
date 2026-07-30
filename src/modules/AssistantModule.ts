import '@/styles/assistant.css';
import { showToast } from '@/utils/toast';
import { edgeTtsSpeak, edgeTtsStop, edgeTtsUnlock } from '@/services/edgeTts';
import { aiPage, aiGlow } from '@/services/aiPageContext';
import { installGlobalAiActions } from '@/services/aiPageCapabilities';
import { changeLog } from '@/modules/LogsModule';
import { esc } from '@/utils/format';
import { supportChatService, supportErrorText, SupportMessage, SupportAttachment, SUPPORT_REASONS } from '@/services/supportChatService';
import { selectionCtx } from '@/services/selectionContext';
import { reportAiUsage } from '@/services/aiUsage';
import { SupportSpamGuard } from '@/services/supportSpamGuard';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface NavAction {
  action: 'navigate';
  page: string;
  label?: string;
}

interface AttachedFile {
  name: string;
  kind: 'image' | 'text';
  textContent?: string;
  imageDataUrl?: string;
  size: number;
}

interface TaskAction {
  action: 'create_task' | 'create_tasks' | 'suggest_task';
  title?: string;
  description?: string;
  priority?: 'none' | 'blue' | 'yellow' | 'red';
  due_date?: string;
  due_time?: string;
  tasks?: Array<{ title: string; description?: string; priority?: string; due_date?: string }>;
}

// ── Человеческие названия действий для журнала ──────────────────────────────────
const ACTION_LABELS: Record<string, string> = {
  excel_replace: 'Замена в таблице',
  excel_set_cell: 'Изменение ячейки',
  excel_style_column: 'Оформление колонки',
  excel_improve_design: 'Улучшение дизайна таблицы',
  word_replace: 'Замена в документе',
  create_doc: 'Создание документа',
};

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ты — Сима, профессиональный AI-менеджер маркетплейсов в системе SimaDesk (2026). Ты работаешь как старший операционный менеджер с 7+ лет опыта на Wildberries, Ozon и Яндекс Маркет. Ты одновременно являешься НАВИГАТОРОМ (помогаешь разобраться в SimaDesk) и МЕНЕДЖЕРОМ (анализируешь данные, выявляешь риски, создаёшь задачи).

## НАВИГАЦИЯ
Если пользователь говорит "открой/перейди/покажи/запусти [раздел]" — ответь СТРОГО JSON без пояснений:
{"action":"navigate","page":"page_id","label":"Название"}
Разделы: home, analytics, repricer, orders, products-hub, stock, producers, tasks, simastore, marketplaces, ozon, wb, yandex, settings, profile, reviews, chats, docs

## АВТОМАТИЧЕСКОЕ РЕШЕНИЕ ПРОБЛЕМ ИНТЕРФЕЙСА
Если пользователь сообщает о проблеме с интерфейсом SimaDesk, которую можно исправить одной кнопкой — предложи это:
Доступные действия (добавь в конец ответа ОДИН JSON если подходит):
{"action":"page_action","name":"toggle_theme_off","args":{},"plan":"Выключить светлую тему — переключить на тёмную"}
{"action":"page_action","name":"toggle_theme_on","args":{},"plan":"Включить светлую тему"}
{"action":"page_action","name":"reload_page","args":{},"plan":"Перезагрузить страницу для обновления данных"}

Примеры когда предлагать:
- "не могу выключить светлую тему" / "хочу тёмную тему" → toggle_theme_off (ТОЛЬКО если текущая тема светлая)
- "данные не обновляются" / "страница зависла" → reload_page
- Всегда сначала объясни ЧТО сделаешь, потом предложи карточку с кнопкой подтверждения.

## СОЗДАНИЕ ЗАДАЧ
ПРАВИЛО: Если пользователь говорит "создай задачу [название]" — НЕМЕДЛЕННО ответь JSON без уточнений. Используй ровно то название что написал пользователь.
{"action":"create_task","title":"Краткое название","description":"Что и почему нужно сделать","priority":"red|yellow|blue|none","due_date":"YYYY-MM-DD","due_time":"HH:MM"}
- priority: red=критично/срочно, yellow=важно, blue=обычная инфо, none=без приоритета
- due_date/due_time — только если пользователь ЯВНО назвал срок, иначе не указывай
- НЕ задавай уточняющих вопросов — создай задачу сразу с тем что сказал пользователь
Несколько задач: {"action":"create_tasks","tasks":[{"title":"...","description":"...","priority":"red"},{"title":"...","priority":"yellow"}]}

Если ты сам РЕКОМЕНДУЕШЬ создать задачу (не пользователь просит, а ты предлагаешь) — используй:
{"action":"suggest_task","title":"...","description":"...","priority":"red|yellow|blue|none"}
Это покажет кнопку для подтверждения, а не автоматически создаст задачу.

## ЗНАНИЯ МЕНЕДЖЕРА МП 2026

### ЕЖЕДНЕВНЫЙ ЧЕКЛИСТ (каждое утро):
1. ЗАКАЗЫ: новые + статусы сборки + дедлайны отгрузки (просрочка = штраф 35% от стоимости + снижение рейтинга)
2. ОСТАТКИ: OOS = потеря позиций навсегда на 7-14 дней даже после пополнения
3. ЦЕНЫ: индекс цены Ozon (должен быть ≤100), конкуренты снизили → репрайсер
4. ОТЗЫВЫ: отвечай на негатив в течение 12 часов (влияет на рейтинг + видимость в поиске)
5. РЕКЛАМА: ДРР, CTR, расход бюджета, стоп/запуск кампаний
6. АНАЛИТИКА: выручка vs прошлая неделя, топ/аутсайдеры, маржа

### КЛЮЧЕВЫЕ МЕТРИКИ И НОРМЫ 2026:
**Конверсия и трафик:**
- CTR карточки в поиске: норма 2-5%. Ниже 1.5% — меняй главное фото/заголовок
- CR (корзина→заказ): норма 3-8%, масс-маркет 1-3%. Ниже 0.8% — критично
- Выкуп (redemption rate): норма 70-85%. Ниже 60% — товар не соответствует описанию

**Реклама:**
- ДРР (доля рекл. расходов): цель до 12-15%. Выше 20% = убыток, выше 30% = стоп-кампания
- ROI рекламы: должен быть >1.3 (каждый рубль даёт 1.3+ рублей прибыли)
- Ozon 2026: трафаретная → брендовая → поисковая. Новинки — медиареклама для быстрого старта
- WB 2026: автореклама (CPM) для новинок, потом CPM по ключам. Оптимизация по дням недели

**Операционные показатели:**
- SLA отгрузки (WB/Ozon FBS): должен быть >97%. Ниже 95% → штрафы, ниже 90% → понижение в выдаче
- Оборачиваемость запасов: оптимум 30-45 дней. Меньше 14 дней → срочный заказ поставщику
- Процент невыкупленных: WB цель <20%, Ozon <15%
- Время обработки отзыва: Ozon требует ответ <72ч (иначе снижение рейтинга магазина)

**Unit-экономика (обязательно для каждого товара):**
- Чистая прибыль = Цена - Себестоимость - Комиссия МП - Логистика - Хранение - Реклама - Возвраты - Налог
- Ozon 2026: комиссия 4-22% (зависит от категории и индекса цены) + логистика 90-600₽ + хранение FBO
- WB 2026: комиссия 10-25% + логистика 40-300₽ + хранение + коэф. скидки 3-12%
- Яндекс Маркет 2026: комиссия 3-18% + доставка партнёром или склад YML
- Минимальная цена = Себестоимость / (1 - Комиссия% - ДРР% - 0.03налог) + Логистика + Хранение

### РИСКИ (проверяй постоянно):
- OOS <14 дней запаса — КРАСНЫЙ риск, нужен срочный заказ
- OOS 0 единиц — КРИТИЧНО, создавай задачу немедленно
- CTR упал >20% за 7 дней — изменился алгоритм или конкуренты
- Возвраты растут >10% — проблема с описанием, фото или качеством
- ДРР >20% — реклама убыточна
- Рейтинг <4.5 — потеря позиций в выдаче
- SLA <95% — штрафы и понижение приоритета
- Блокировка/скрытие карточки — проверяй статусы ежедневно
- Штрафные баллы (WB) — мониторь в личном кабинете
- Изменения комиссий МП — пересчитывай unit-экономику

### СТРАТЕГИЯ РОСТА 2026:
**Карточки товара:**
- Заголовок: ключевой запрос + характеристики (материал, цвет, размер) в первых 80 символах
- Описание: структурированное, bullet-points, SEO-ключи, ответы на возражения покупателей
- Фото: минимум 7-9 фото. Первое фото = 70% CTR. Инфографика с ключевыми преимуществами на 2-3 фото
- Видео: повышает конверсию на 20-35%. На WB обязательно для топа в категориях

**SEO 2026:**
- Сбор семантики: встроенная аналитика МП + Mpstats/Marketguru/Wildbox
- Ключи размещай: заголовок (первые 80 симв), описание, характеристики, rich-контент
- Кластеризация: разные карточки под разные ключевые группы
- WB индексирует отзывы — просить покупателей упоминать ключевые характеристики

**Работа с отзывами:**
- Негатив: ответь в течение 12 часов, предложи решение, укажи телефон/email поддержки
- Нейтральный (3 звезды): уточни проблему, предложи замену/компенсацию
- Позитив: персонализированный ответ, благодарность. Не шаблонный текст
- Методы получения отзывов: вкладыши, бонусные баллы, email-цепочки

### КАК РАБОТАТЬ С SimaDesk — ПОЛНАЯ КАРТА:

**Главная / Дашборд (home)**
Ключевые метрики за день: выручка, новые заказы, остатки в зоне риска, просроченные задачи.
Клик по любой карточке — переход в соответствующий раздел. Обновляй каждое утро.

**Аналитика (analytics)**
Детальный анализ за период (день/неделя/месяц/квартал). Метрики: выручка нетто/брутто, заказы, возвраты, маржа, средний чек, конверсия. Сравнение периодов, разбивка по маркетплейсам и SKU. ABC-анализ товаров по прибыли.

**Репрайсер (repricer)**
Автоматическое управление ценами по правилам. Стратегии: следить за конкурентами, держать позицию, целевая маржа. Настройка: выбрать SKU → "Добавить правило" → стратегия + границы мин/макс цены. ОБЯЗАТЕЛЬНО проверяй unit-экономику перед снижением цены.

**Заказы (orders)**
Все заказы со всех маркетплейсов в одном экране. Фильтры: статус, маркетплейс, дата, SKU. Статусы FBS выделены по дедлайнам — красный = срочно, просрочка = штраф 35%. Группировка для сборки на складе.

**Товары / Products Hub (products-hub)**
Карточки товаров: название, описание, характеристики, цены, фото. Массовое редактирование группы товаров. Статусы: активен/скрыт/архив/требует доработки. SEO-оптимизация описаний.

**Остатки / Склад (stock)**
Текущие остатки по FBO и FBS складам. Ключевая метрика: "Дней до OOS" — критично < 14 дней, 0 = срочный заказ. Сортировка по критичности. Настрой пороги уведомлений (шестерёнка в разделе).

**Производители / Поставщики (producers)**
База поставщиков и производителей. Хранит: контакты, условия, прайсы, историю заказов. Связан с разделом Остатки для планирования поставок.

**Задачи (tasks)**
Планировщик операционных задач команды. Приоритеты: 🔴 срочно, 🟡 важно, 🔵 инфо. Создание: кнопка "+" или скажи мне "создай задачу [название]". Фильтры по дате/исполнителю/статусу. Просроченные задачи выделяются красным.

**Витрина / SimaStore (simastore)**
Собственный интернет-магазин без маркетплейса. URL: /s/название. Товары синхронизируются из Products Hub. Подключение оплаты и доставки через настройки витрины.

**Подключение маркетплейсов (marketplaces)**
Подключение API аккаунтов WB, Ozon, Яндекс Маркет. Как получить ключ:
- WB: ЛК → Профиль → Настройки → Токены API → создать с нужными правами
- Ozon: ЛК → API → Ключи → Создать ключ (тип: Стандартный)
- Яндекс Маркет: ЛК → Настройки → API → создать OAuth-токен
После подключения первая синхронизация 15-30 минут.

**Настройки (settings)**
Профиль и безопасность, смена пароля. Подключение маркетплейсов. Настройки AI (Сима): здесь вводится OpenRouter API-ключ — без него я не работаю. Управление командой: добавить/удалить пользователей компании. Тарифы и подписка.

**Профиль (profile)**
Личные данные, фото профиля, контакты. История входов и устройств.

**Отзывы (reviews)**
Мониторинг отзывов со всех маркетплейсов. Фильтр по оценке (1-5★), маркетплейсу, наличию ответа. Приоритет: сначала 1★ и 2★ без ответа. Шаблоны ответов — редактируются в настройках раздела. Ozon: ответить нужно за 72ч иначе снижение рейтинга магазина.

**Редактор / Документы (docs)**
Встроенный Excel и Word редактор. Excel: .xlsx/.xls, формулы, форматирование, импорт/экспорт. Word: .docx, форматирование, таблицы. Я умею редактировать файлы командами: "замени значение в ячейке A1", "найди и замени текст в документе".

**Поддержка SimaDesk (chats / support)**
Кнопка «Поддержка» в этой панели → вкладка «Поддержка». Живые операторы + AI-помощник. История чата удаляется после завершения диалога.

### ТИПИЧНЫЕ ВОПРОСЫ И ОТВЕТЫ

"Как подключить Wildberries/Ozon/ЯМ?" → раздел Маркетплейсы → ввести API-ключ из ЛК МП
"Как добавить задачу?" → раздел Задачи → "+" или скажи мне "создай задачу..."
"Как переключить тему (светлая/тёмная)?" → Настройки → переключатель темы, или скажи мне "переключи на тёмную тему" и я это сделаю
"Данные не обновляются?" → проверь подключение API в Маркетплейсах, синхронизация каждые 30 мин
"Как настроить репрайсер?" → Репрайсер → выбрать товар → "Добавить правило"
"Где посмотреть остатки?" → Остатки (Склад) → колонка "Дней до OOS"
"Как ответить на отзыв?" → Отзывы → найти отзыв → "Ответить"
"Как узнать выручку за месяц?" → Аналитика → период "Месяц" → карточка "Выручка нетто"
"Сима не отвечает / ошибка AI?" → Настройки → Настройки AI → проверить OpenRouter API-ключ и баланс на openrouter.ai
"Не могу войти в аккаунт?" → кнопка "Забыли пароль?" на форме входа
"Как изменить тариф?" → Настройки → Подписка → или обратись в поддержку через вкладку «Поддержка»
"Как добавить сотрудника?" → Настройки → Команда → "Пригласить пользователя"

## РАБОТА С ДАННЫМИ МАГАЗИНА
Если в запросе есть [ТЕКУЩИЕ ДАННЫЕ МАГАЗИНА] — используй их для конкретного анализа.
Всегда ищи: аномалии, отклонения от норм, товары в зоне риска.
Приоритизируй: критичные риски (OOS, штрафы) > важные (падение метрик) > оптимизация.

## СТИЛЬ ОТВЕТА
- Конкретно и по делу: вывод → причина → действие
- Цифры и метрики, не общие слова
- Максимум 3-5 пунктов действий, не длинные списки
- Если нужно создать задачу — предложи через suggest_task или создай через create_task
- Отвечай по-русски, профессионально, но без лишнего официоза

## ОГРАНИЧЕНИЯ ТЕМАТИКИ
Ты отвечаешь ТОЛЬКО на вопросы по темам:
- Маркетплейсы: WB, Ozon, Яндекс Маркет, Авито и работа на них
- SimaDesk: функции, разделы, как пользоваться сервисом
- Аналитика продаж, юнит-экономика, ценообразование, маржа
- Логистика: FBO, FBS, склады, остатки, поставки
- Реклама на маркетплейсах (ДРР, CTR, кампании)
- Работа с поставщиками и закупки
- Онлайн-торговля, бизнес-процессы в e-commerce
- Отзывы, репутация, рейтинги на МП

Если вопрос НЕ связан с этими темами (история, политика, наука, знаменитости, математика общего плана, программирование не связанное с МП, и т.п.) — ответь СТРОГО и коротко:
"Я ассистент SimaDesk — помогаю с маркетплейсами и работой сервиса. Задай вопрос о торговле на WB, Ozon, Яндекс Маркет или о функциях SimaDesk."
Не объясняй почему не отвечаешь. Просто верни эту фразу и больше ничего.

## ПЕРЕКЛЮЧЕНИЕ НА ПОДДЕРЖКУ
Если пользователь говорит что хочет написать в поддержку, поговорить с оператором, жалуется что ты не помогаешь или что-то не работает в сервисе — ответь строго JSON:
{"action":"open_support"}

## КНОПКИ-ПОДСКАЗКИ ПОСЛЕ ОТВЕТА
После каждого обычного ответа (не JSON-команд навигации, создания задач или page_action) добавляй в самый конец ответа JSON с 2–3 короткими кнопками для продолжения диалога:
{"suggestions":["текст кнопки 1","текст кнопки 2"]}
Кнопки: 3–5 слов, конкретные, без emoji. НЕ добавляй ничего после JSON.
Если ответ — это JSON навигации, создания задачи или page_action — suggestions НЕ нужны.`;

// ── Nav command patterns (client-side fast matching, no API needed) ────────────

const NAV_PATTERNS: Array<{ re: RegExp; page: string; label: string }> = [
  { re: /(?:главн|дашборд|домой|home)/i,                          page: 'home',         label: 'Главная' },
  { re: /аналит/i,                                                page: 'analytics',    label: 'Аналитика' },
  { re: /репрайс|цен[аы]|price/i,                                 page: 'repricer',     label: 'Репрайсер' },
  { re: /заказ/i,                                                  page: 'orders',       label: 'Заказы' },
  { re: /товар|обзор|product/i,                                   page: 'products-hub', label: 'Товары' },
  { re: /остат|склад|stock/i,                                     page: 'stock',        label: 'Остатки' },
  { re: /произво|поставщ/i,                                       page: 'producers',    label: 'Производители' },
  { re: /задач|task/i,                                             page: 'tasks',        label: 'Задачи' },
  { re: /витрин|simastore|магазин/i,                              page: 'simastore',    label: 'Витрина' },
  { re: /api\s*маркет|маркетплейс|подключ/i,                      page: 'marketplaces', label: 'API Маркет' },
  { re: /\bozon\b|озон/i,                                         page: 'ozon',         label: 'Ozon' },
  { re: /\bwb\b|вайлдберри|wildberries/i,                         page: 'wb',           label: 'Wildberries' },
  { re: /яндекс|yandex/i,                                         page: 'yandex',       label: 'Яндекс Маркет' },
  { re: /настройк|setting/i,                                      page: 'settings',     label: 'Настройки' },
  { re: /профил|профайл|profile/i,                                page: 'profile',      label: 'Профиль' },
  { re: /отзыв|review/i,                                          page: 'reviews',      label: 'Отзывы' },
  { re: /чат|chat/i,                                              page: 'chats',        label: 'Чаты' },
  { re: /редактор|документ|docs/i,                                page: 'docs',         label: 'Редактор' },
];

const OPEN_PREFIXES = /^(?:открой|открыть|перейди\s+(?:в|на)|покажи|запусти|зайди\s+(?:в|на)|иди\s+(?:в|на)|go\s+to|open)\s+/i;

function tryLocalNav(text: string): NavAction | null {
  const clean = text.trim().replace(OPEN_PREFIXES, '');
  for (const { re, page, label } of NAV_PATTERNS) {
    if (re.test(clean)) return { action: 'navigate', page, label };
  }
  return null;
}

// Is this message clearly a nav command?
const IS_NAV_COMMAND = /^(?:открой|открыть|перейди|покажи|запусти|зайди|иди|go\s+to|open)\s+/i;

// ── Hint suggestions shown at panel open ──────────────────────────────────────

const HINTS = [
  'Открой аналитику',
  'Что проверить сегодня?',
  'Как улучшить позиции?',
  'Открой репрайсер',
  'Что такое ДРР?',
  'Открой заказы',
  'Как работать с отзывами?',
  'Открой остатки',
];

// ── Store context collector ───────────────────────────────────────────────────

function getStoreContext(): string {
  const sections: string[] = [];
  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} млн ₽`
    : n >= 1_000 ? `${(n / 1_000).toFixed(0)} тыс ₽`
    : `${Math.round(n)} ₽`;

  try {
    const am = (window as any).analyticsModule;
    if (am) {
      const kpi = (am as any).kpi;
      const orders: any[] = (am as any).orders ?? [];
      if (kpi && orders.length > 0) {
        const byMp: Record<string, number> = {};
        orders.forEach((o: any) => { byMp[o.mp] = (byMp[o.mp] || 0) + 1; });
        const mpStr = Object.entries(byMp).map(([k, v]) => `${k}: ${v}`).join(', ');
        sections.push(`АНАЛИТИКА (текущий период):
Выручка нетто: ${fmt(kpi.revenue)}, Валовая: ${fmt(kpi.revenue_gross)}
Заказов: ${kpi.orders_delivered + kpi.orders_processing} | Возвраты: ${kpi.orders_returned} | Отмены: ${kpi.orders_cancelled}
Маржа: ${kpi.margin_pct?.toFixed(1)}% | Ср. чек: ${fmt(kpi.avg_check)}
Комиссии МП: ${fmt(kpi.commission)} | Логистика: ${fmt(kpi.logistics)}
По маркетплейсам: ${mpStr}`);
      }
    }
  } catch { /* ignore */ }

  try {
    const sm = (window as any).stockModule;
    if (sm) {
      const items: any[] = (sm as any).items ?? [];
      if (items.length > 0) {
        const oos = items.filter(i => i.stockTotal === 0);
        const low = items.filter(i => i.stockTotal > 0 && i.stockTotal < 10);
        const ok  = items.filter(i => i.stockTotal >= 10);
        sections.push(`ОСТАТКИ: Всего SKU: ${items.length} | Норма: ${ok.length} | Критично (<10 ед): ${low.length} | OOS: ${oos.length}`
          + (oos.length > 0 ? `\nOOS товары: ${oos.slice(0, 5).map(i => `"${i.name || i.offerId}"(${i.mp})`).join(', ')}${oos.length > 5 ? ` + ещё ${oos.length - 5}` : ''}` : '')
          + (low.length > 0 ? `\nКритично мало: ${low.slice(0, 4).map(i => `"${i.name || i.offerId}" ${i.stockTotal}шт`).join(', ')}` : ''));
      }
    }
  } catch { /* ignore */ }

  try {
    const om = (window as any).allOrdersModule;
    if (om) {
      const orders: any[] = (om as any).orders ?? [];
      if (orders.length > 0) {
        const byStatus: Record<string, number> = {};
        orders.forEach((o: any) => { const s = o.status || 'unknown'; byStatus[s] = (byStatus[s] || 0) + 1; });
        sections.push(`ЗАКАЗЫ: Всего: ${orders.length} | ` + Object.entries(byStatus).slice(0, 5).map(([s, n]) => `${s}: ${n}`).join(' | '));
      }
    }
  } catch { /* ignore */ }

  try {
    const tm = (window as any).taskManagerModule;
    if (tm) {
      const tasks: any[] = (tm as any).tasks ?? [];
      if (tasks.length > 0) {
        const open = tasks.filter(t => t.status !== 'done');
        const overdue = open.filter(t => t.due_date && new Date(t.due_date) < new Date());
        sections.push(`ЗАДАЧИ: Открытых: ${open.length} | Просрочено: ${overdue.length}`
          + (overdue.length > 0 ? `\nПросроченные: ${overdue.slice(0, 3).map(t => `"${t.title}"`).join(', ')}` : ''));
      }
    }
  } catch { /* ignore */ }

  try {
    const rm = (window as any).reviewsModule;
    if (rm) {
      const reviews: any[] = (rm as any).reviews ?? [];
      if (reviews.length > 0) {
        const unanswered = reviews.filter((r: any) => !r.reply && r.stars <= 3);
        const negative = reviews.filter((r: any) => r.stars <= 2);
        sections.push(`ОТЗЫВЫ: Всего: ${reviews.length} | Негативных (1-2★): ${negative.length} | Без ответа (≤3★): ${unanswered.length}`
          + (unanswered.length > 0 ? `\nТребуют ответа: ${unanswered.slice(0, 3).map((r: any) => `"${String(r.productName || r.text || '').slice(0, 30)}"(${r.stars}★)`).join(', ')}` : ''));
      }
    }
  } catch { /* ignore */ }

  try {
    const rep = (window as any).repricerModule;
    if (rep) {
      const rules: any[] = (rep as any).rules ?? [];
      const items: any[] = (rep as any).items ?? [];
      if (rules.length > 0 || items.length > 0) {
        sections.push(`РЕПРАЙСЕР: Правил: ${rules.length} | SKU под управлением: ${items.length}`);
      }
    }
  } catch { /* ignore */ }

  return sections.length > 0
    ? '\n\n[ТЕКУЩИЕ ДАННЫЕ МАГАЗИНА]\n' + sections.join('\n\n')
    : '';
}

// ── TTS ───────────────────────────────────────────────────────────────────────

function cleanForTTS(text: string): string {
  return text
    // Remove code blocks entirely (including ```json ... ```)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    // Remove URLs
    .replace(/https?:\/\/\S+/g, '')
    // Remove JSON action blocks
    .replace(/\{[\s\S]*?"action"[\s\S]*?\}/g, '')
    // Remove markdown formatting symbols
    .replace(/[*_#~>|]/g, '')
    // Remove parenthetical descriptions like (*вздыхает*)
    .replace(/\(?\*[^*]+\*\)?/g, '')
    // Remove square bracket descriptions like [смеётся]
    .replace(/\[[^\]]{1,40}\]/g, '')
    // Strip ALL emoji via Unicode property escapes
    .replace(/\p{Emoji_Presentation}/gu, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    // Strip emoji by explicit Unicode ranges (fallback for older engines)
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FEFF}]/gu, '')
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
    // Currency / units → spoken words (BEFORE stripping other symbols)
    .replace(/₽/g, ' рублей')
    .replace(/%/g, ' процентов')
    // Math / comparison symbols → natural words or pauses
    .replace(/≈/g, ' примерно ')
    .replace(/≥/g, ' не менее ')
    .replace(/≤/g, ' не более ')
    .replace(/×/g, ' на ')
    .replace(/→|←|⇒/g, ', ')
    // Remove symbols that get read aloud as words (plus, equals, etc.)
    .replace(/[+=<>@^&\\]/g, ' ')
    // Remove numbered list markers "1. " "2. " at line start (don't read as "один, два")
    .replace(/^\d+\.\s+/gm, '')
    // Replace bullet list markers
    .replace(/^[-•*]\s+/gm, '')
    // Headers → just the text
    .replace(/^#{1,3}\s+/gm, '')
    // Em-dash / en-dash between words → comma (short pause)
    .replace(/\s*[—–]\s*/g, ', ')
    // Colon at end of line introducing a list → comma
    .replace(/:\s*\n/g, ', ')
    // Convert newlines to natural sentence pause
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    // Collapse repeated punctuation
    .replace(/\.{2,}/g, '.')
    .replace(/,{2,}/g, ',')
    .replace(/,\s*\./g, '.')
    // Collapse spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function ttsSpeak(text: string, onEnd?: () => void, rate = 1.1, voice = 'ru-RU-SvetlanaNeural'): void {
  const clean = cleanForTTS(text);
  if (!clean) { onEnd?.(); return; }
  edgeTtsUnlock();
  edgeTtsSpeak(clean, onEnd, rate, voice).catch(() => { onEnd?.(); });
}

function ttsStop(): void {
  edgeTtsStop();
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<strong style="font-size:11px;color:rgba(200,170,255,0.95)">$1</strong>')
    .replace(/^## (.+)$/gm,  '<strong style="font-size:12px;color:rgba(210,180,255,1)">$1</strong>')
    .replace(/^[-•] (.+)$/gm, '• $1')
    .replace(/\n/g, '<br>');
}

// ── Config helpers ────────────────────────────────────────────────────────────

async function loadAiConfig(): Promise<{ key: string; model: string }> {
  // Key is session-scoped (cleared on tab close); model is not sensitive → localStorage.
  // The stale localStorage 'sd_ai_key' is ignored to avoid long-term plaintext exposure.
  const key   = sessionStorage.getItem('sd_ai_key') || '';
  const model = localStorage.getItem('sd_ai_model') || 'anthropic/claude-haiku-4-5';

  // After auth: refresh from Supabase site_content (source of truth, set by admin)
  if (typeof window !== 'undefined') {
    try {
      const { dbFetch } = await import('@/services/dbClient');
      const rows = await dbFetch<Array<{ key: string; content: string }>>('/rpc/get_site_content', {
        method: 'POST', body: '{}',
      });
      const arr = Array.isArray(rows) ? rows : [];
      const remoteKey   = arr.find(r => r.key === 'ai_openrouter_key')?.content;
      const remoteModel = arr.find(r => r.key === 'ai_model')?.content;
      if (remoteKey)   sessionStorage.setItem('sd_ai_key', remoteKey);
      if (remoteModel) localStorage.setItem('sd_ai_model', remoteModel);
      return {
        key:   remoteKey   || key,
        model: remoteModel || model,
      };
    } catch { /* unauthenticated or Supabase unavailable — use session-cached values */ }
  }

  return { key, model };
}

// ── Main AssistantModule class ────────────────────────────────────────────────

export class AssistantModule {
  private panel: HTMLElement | null = null;
  private btn: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private textareaEl: HTMLTextAreaElement | null = null;
  private statusEl: HTMLElement | null = null;

  private history: ChatMessage[] = [];
  private isOpen = false;
  private isResizing = false;
  private isLoading = false;
  private pageActionsUnsub: (() => void) | null = null;
  private isListening = false;
  private recognition: any = null;
  private voicePrefix = '';
  private attachedFiles: AttachedFile[] = [];
  private fileInputEl: HTMLInputElement | null = null;
  private aiKey = '';
  private aiModel = '';
  private ttsEnabled = localStorage.getItem('sd_tts_enabled') !== 'false';
  private ttsRate = parseFloat(localStorage.getItem('sd_tts_rate') || '1.1');
  // Edge TTS voice ID — default to Svetlana Neural; migrate legacy Web Speech API names
  private ttsVoiceName = (() => {
    const s = localStorage.getItem('sd_tts_voice') || '';
    return /^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(s) ? s : 'ru-RU-SvetlanaNeural';
  })();
  private voiceOnboarded = !!localStorage.getItem('sd_voice_onboarded');
  private speakingBtn: HTMLElement | null = null;
  private voiceSendOnEnd = false;  // when true: auto-send after voice stops
  private voiceHotkeyHeld = false; // Alt+Space hotkey currently held

  // ── AI Cursor ──────────────────────────────────────────────────────────────
  private aiCursorActive = false;
  private aiCursorOverlay: HTMLDivElement | null = null;
  private aiCursorCleanup: (() => void) | null = null;

  // ── Support chat state ─────────────────────────────────────────────────────
  private supportMode: 'ai' | 'support' = 'ai';
  private supportChatId: string | null = localStorage.getItem('sd_sup_chat_id');
  private supportReason: string = localStorage.getItem('sd_sup_reason') || '';
  private supportMessages: SupportMessage[] = [];
  private supportPollTimer: ReturnType<typeof setInterval> | null = null;
  private supportLastMsgTime: string | null = null;
  private supportChatClosed = false;

  /** Call after DOM is ready. Safe to call multiple times — only creates panel once. */
  async init(): Promise<void> {
    // Expose early so admin panel and debug tools can access it
    (window as any).sdAssistantModule = this;

    this.btn = document.getElementById('nav-assistant');
    if (!this.btn) return;

    // Register global AI actions once (create_doc, etc.)
    installGlobalAiActions();

    // Only create panel and wire click once
    if (!this.panel) {
      this.createPanel();
      this.btn.addEventListener('click', () => this.togglePanel());
      // Если диалог с поддержкой уже открыт — следим за ответом оператора
      // в фоне, чтобы показать бейдж, даже пока панель закрыта.
      if (this.supportChatId) this.startSupportPolling();
    }

    // Load config (may fail if unauthenticated — that's OK, key loads later)
    try {
      const cfg = await loadAiConfig();
      this.aiKey   = cfg.key;
      this.aiModel = cfg.model;
      // If key found after async load — hide the key-setup block that was shown pre-load
      if (this.aiKey && this.panel) {
        const keySetup = this.panel.querySelector<HTMLElement>('.sd-ap-key-setup');
        if (keySetup) keySetup.style.display = 'none';
      }
    } catch { /* key stays empty; shown as "not configured" error on first use */ }

    // Listen for config updates from admin panel (updateConfig() is called directly, but
    // the event fires for other potential listeners — read from session cache as fallback)
    window.addEventListener('sd_ai_config_updated', () => {
      this.aiKey   = sessionStorage.getItem('sd_ai_key') || this.aiKey;
      this.aiModel = localStorage.getItem('sd_ai_model') || this.aiModel;
    });
  }

  /** Called by admin panel to update config without page reload */
  updateConfig(key: string, model: string): void {
    this.aiKey   = key;
    this.aiModel = model;
  }

  private createPanel(): void {
    const panel = document.createElement('div');
    panel.className = 'sd-assistant-panel';
    panel.id = 'sd-assistant-panel';
    panel.innerHTML = '<div class="sd-ap-resize-handle" title="Потяни чтобы изменить размер"></div><div class="sd-ap-arrow"></div>' + this.renderPanelHTML();
    document.body.appendChild(panel);
    this.panel = panel;
    this.messagesEl  = panel.querySelector('.sd-ap-messages');
    this.textareaEl  = panel.querySelector('.sd-ap-textarea') as HTMLTextAreaElement;
    this.statusEl    = panel.querySelector('.sd-ap-status');

    panel.querySelector('.sd-ap-close')?.addEventListener('click', () => this.closePanel());
    panel.querySelector('.sd-ap-send-btn')?.addEventListener('click', () => this.handleSend());
    const micBtn = panel.querySelector<HTMLElement>('.sd-ap-mic-btn');
    if (micBtn) {
      micBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.voiceSendOnEnd = false; this.startVoice(); });
      micBtn.addEventListener('pointerup',   () => { this.stopVoice(); });
      micBtn.addEventListener('pointercancel', () => { this.stopVoice(); });
    }

    // Mode tabs: Сима / Поддержка
    panel.querySelectorAll<HTMLElement>('.sd-ap-mode-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchSupportMode(tab.dataset.mode as 'ai' | 'support'));
    });

    // Close panel on click outside (panel or toggle button)
    document.addEventListener('click', (e) => {
      if (!this.isOpen) return;
      const target = e.target as Node;
      if (!panel.contains(target) && !this.btn?.contains(target)) {
        this.closePanel();
      }
    }, { capture: false });
    panel.querySelector('.sd-ap-tts-btn')?.addEventListener('click', () => this.toggleTts());
    panel.querySelector('.sd-ap-clear-btn')?.addEventListener('click', () => this.clearChat());
    panel.querySelector('.sd-ap-key-save')?.addEventListener('click', () => this.saveKeyFromPanel());
    // Quick actions accordion toggle
    panel.querySelector('#sd-ap-qa-header')?.addEventListener('click', () => {
      panel.querySelector('#sd-ap-quick-actions')?.classList.toggle('open');
    });

    // Settings accordion
    panel.querySelector('#sd-ap-settings-header')?.addEventListener('click', () => {
      panel.querySelector('#sd-ap-settings-section')?.classList.toggle('open');
    });

    // Speed slider
    const speedSlider = panel.querySelector<HTMLInputElement>('.sd-ap-speed-slider');
    const speedVal    = panel.querySelector<HTMLElement>('.sd-ap-speed-val');
    speedSlider?.addEventListener('input', () => {
      this.ttsRate = parseFloat(speedSlider.value);
      localStorage.setItem('sd_tts_rate', String(this.ttsRate));
      if (speedVal) speedVal.textContent = `${this.ttsRate.toFixed(1)}×`;
    });

    // Voice selector — Edge TTS voices (fixed list)
    const voiceSelect = panel.querySelector<HTMLSelectElement>('.sd-ap-voice-select');
    if (voiceSelect) {
      voiceSelect.value = this.ttsVoiceName;
      voiceSelect.addEventListener('change', () => {
        this.ttsVoiceName = voiceSelect.value;
        localStorage.setItem('sd_tts_voice', this.ttsVoiceName);
      });
    }
    panel.querySelectorAll('.sd-ap-hint').forEach(h => {
      h.addEventListener('click', () => this.sendMessage((h as HTMLElement).textContent || ''));
    });
    panel.querySelectorAll('.sd-ap-qa-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = (btn as HTMLElement).dataset.action || '';
        // Accordion: highlight active, dim others, then collapse
        panel.querySelectorAll('.sd-ap-qa-btn').forEach(b => b.classList.add('qa-dimmed'));
        (btn as HTMLElement).classList.remove('qa-dimmed');
        (btn as HTMLElement).classList.add('qa-active');
        setTimeout(() => {
          panel.querySelector('#sd-ap-quick-actions')?.classList.remove('open');
          panel.querySelectorAll('.sd-ap-qa-btn').forEach(b => {
            b.classList.remove('qa-dimmed', 'qa-active');
          });
        }, 400);
        this.handleQuickAction(action);
      });
    });

    this.textareaEl?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (this.ttsEnabled) edgeTtsUnlock(); // user gesture context
        this.handleSend();
      }
    });
    this.textareaEl?.addEventListener('input', () => this.autoResizeTextarea());

    this.updateTtsBtn();

    this.setupResize(panel);
    this.setupFileAttach(panel);
    this.setupPositionTracking();
    this.setupSelectionCtx(panel);
    this.setupAiCursor(panel);
    this.setupVoiceHotkey();

    // Listen for native text selection on any page
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().trim();
      if (text.length < 5) return;
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer as Node;
      const el = container.nodeType === Node.ELEMENT_NODE ? container as HTMLElement : container.parentElement;
      // Skip: assistant panel itself, Excel cells, inputs
      if (el?.closest('#sd-assistant-panel, #docs-excel-body, input, textarea')) return;
      selectionCtx.set({
        type: 'text',
        label: `«${text.slice(0, 45)}${text.length > 45 ? '…' : ''}»`,
        prompt: `[КОНТЕКСТ: выделенный текст на странице]\n${text.slice(0, 800)}${text.length > 800 ? '\n...' : ''}`,
        data: { text },
      });
    });

    this.addAssistantMessage(
      'Привет! Я Сима — ваш персональный менеджер маркетплейсов. ' +
      'Помогу разобраться в SimaDesk и улучшить показатели. ' +
      'Открывайте разделы голосом или задавайте вопросы о маркетплейсах.'
    );

    // Кнопки-подсказки под текущую страницу + обновление при смене раздела.
    this.renderPageActions();
    if (!this.pageActionsUnsub) {
      this.pageActionsUnsub = aiPage.onChange(() => this.renderPageActions());
    }
  }

  /** Отрисовать кнопки-подсказки, релевантные текущей открытой странице. */
  private renderPageActions(): void {
    const host = this.panel?.querySelector<HTMLElement>('#sd-ap-page-actions');
    if (!host) return;
    const cap = aiPage.current();
    const suggestions = cap?.suggestions ?? [];
    if (!suggestions.length) { host.innerHTML = ''; return; }
    host.innerHTML =
      `<div class="sd-ap-page-actions-title">На странице «${cap!.title}»</div>` +
      `<div class="sd-ap-page-actions-grid">` +
      suggestions.map((s, i) =>
        `<button class="sd-ap-page-btn" data-idx="${i}">${s.label}</button>`,
      ).join('') +
      `</div>`;
    host.querySelectorAll<HTMLButtonElement>('.sd-ap-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = +(btn.dataset.idx ?? '-1');
        const s = suggestions[idx];
        if (!s) return;
        // Для «create task » и подобных незавершённых промптов — подставим в поле ввода.
        if (s.prompt.trim().endsWith(' ') && this.textareaEl) {
          this.textareaEl.value = s.prompt;
          this.textareaEl.focus();
          this.autoResizeTextarea();
        } else {
          this.sendMessage(s.prompt);
        }
      });
    });
  }

  private renderPanelHTML(): string {
    const hints = HINTS.slice(0, 4).map(h => `<button class="sd-ap-hint">${h}</button>`).join('');
    const noKey = !this.aiKey;
    return `
      <div class="sd-ap-header">
        <div class="sd-ap-avatar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 2C8 2 5 5 5 9c0 2.8 1.5 5.2 3.7 6.5L8 18h8l-.7-2.5C17.5 14.2 19 11.8 19 9c0-4-3-7-7-7z"/>
            <path d="M9 21h6M10 18v3M14 18v3"/>
            <circle cx="9" cy="9" r="1" fill="currentColor" stroke="none"/>
            <circle cx="15" cy="9" r="1" fill="currentColor" stroke="none"/>
          </svg>
        </div>
        <div class="sd-ap-title">
          <h3>Сима</h3>
          <p>AI-менеджер маркетплейсов</p>
        </div>
        <div class="sd-ap-status" id="sd-ap-status">Готова</div>
        <div class="sd-ap-header-actions">
          <button class="sd-ap-btn sd-ap-tts-btn" title="Озвучка текста">
            <svg class="tts-icon-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
            <svg class="tts-icon-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <line x1="23" y1="9" x2="17" y2="15"/>
              <line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
          </button>
          <button class="sd-ap-btn sd-ap-clear-btn" title="Очистить чат">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
            </svg>
          </button>
          <button class="sd-ap-close" title="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <div class="sd-ap-mode-tabs" id="sd-ap-mode-tabs">
        <button class="sd-ap-mode-tab active" data-mode="ai">Сима</button>
        <button class="sd-ap-mode-tab" data-mode="support">Поддержка<span class="sd-ap-tab-dot" id="sd-ap-sup-dot" style="display:none"></span></button>
      </div>
      <div class="sd-ap-scroll" id="sd-ap-scroll">
      ${noKey ? `
      <div class="sd-ap-key-setup">
        <div class="sd-ap-key-label">Введите API-ключ OpenRouter для активации AI</div>
        <div class="sd-ap-key-row">
          <input class="sd-ap-key-input" type="password" placeholder="sk-or-v1-…" autocomplete="off">
          <button class="sd-ap-key-save">Сохранить</button>
        </div>
        <a class="sd-ap-key-link" href="https://openrouter.ai/keys" target="_blank">Получить ключ на openrouter.ai</a>
      </div>` : ''}
      <div class="sd-ap-quick-actions" id="sd-ap-quick-actions">
        <div class="sd-ap-qa-header" id="sd-ap-qa-header">
          <span class="sd-ap-qa-title">Быстрые действия</span>
          <svg class="sd-ap-qa-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="sd-ap-qa-body">
          <div class="sd-ap-qa-grid">
            <button class="sd-ap-qa-btn" data-action="analytics30">Аналитика 30 дней</button>
            <button class="sd-ap-qa-btn" data-action="stockRisk">Риски остатков</button>
            <button class="sd-ap-qa-btn" data-action="ordersCheck">Проверить заказы</button>
            <button class="sd-ap-qa-btn" data-action="dailyCheck">Дневной чеклист</button>
            <button class="sd-ap-qa-btn" data-action="priceAnalysis">Анализ цен</button>
            <button class="sd-ap-qa-btn" data-action="howTo">Как пользоваться</button>
            <button class="sd-ap-qa-btn" data-action="reviewsCheck">Проверить отзывы</button>
            <button class="sd-ap-qa-btn" data-action="unitEconomy">Unit-экономика</button>
            <button class="sd-ap-qa-btn" data-action="seoAdvice">SEO карточек</button>
            <button class="sd-ap-qa-btn" data-action="adStrategy">Реклама</button>
            <button class="sd-ap-qa-btn" data-action="risks">Найти риски</button>
            <button class="sd-ap-qa-btn" data-action="growthPlan">План роста</button>
          </div>
        </div>
      </div>
      <div class="sd-ap-quick-actions" id="sd-ap-settings-section">
        <div class="sd-ap-qa-header" id="sd-ap-settings-header">
          <span class="sd-ap-qa-title">Настройки ассистента</span>
          <svg class="sd-ap-qa-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="sd-ap-qa-body">
          <div class="sd-ap-settings-body">
            <div class="sd-ap-setting-row">
              <label class="sd-ap-setting-label">Скорость озвучки</label>
              <div class="sd-ap-speed-row">
                <span class="sd-ap-speed-val">${(this.ttsRate).toFixed(1)}×</span>
                <input type="range" class="sd-ap-speed-slider" min="0.5" max="2" step="0.1" value="${this.ttsRate}">
              </div>
            </div>
            <div class="sd-ap-setting-row">
              <label class="sd-ap-setting-label">Голос Edge-TTS</label>
              <select class="sd-ap-voice-select">
                <option value="ru-RU-SvetlanaNeural">Svetlana Neural — женский (рекомендуется)</option>
                <option value="ru-RU-DmitryNeural">Dmitry Neural — мужской</option>
              </select>
            </div>
            <div class="sd-ap-setting-note">Microsoft Edge-TTS Neural — тот же движок что в SIMA OS. Работает в любом браузере.</div>
          </div>
        </div>
      </div>
      <div class="sd-ap-hints">${hints}</div>
      <div class="sd-ap-page-actions" id="sd-ap-page-actions"></div>
      <div class="sd-ap-messages" id="sd-ap-messages"></div>
      </div>
      <div class="sd-ap-ctx-chip" id="sd-ap-ctx-chip" style="display:none">
        <span class="sd-ap-ctx-icon" id="sd-ap-ctx-icon">📋</span>
        <span class="sd-ap-ctx-label" id="sd-ap-ctx-label"></span>
        <button class="sd-ap-ctx-close" id="sd-ap-ctx-close" title="Убрать контекст">×</button>
      </div>
      <div class="sd-ap-attach-chips" id="sd-ap-attach-chips"></div>
      <div class="sd-ap-input-area">
        <button class="sd-ap-btn sd-ap-attach-btn" title="Прикрепить файл (Excel, Word, PDF, фото)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </button>
        <button class="sd-ap-btn sd-ap-cursor-btn" id="sd-ap-cursor-btn" title="AI-курсор: наведи на любой элемент и нажми — Сима увидит контекст">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
        </button>
        <input class="sd-ap-file-input" type="file" accept=".xlsx,.xls,.docx,.doc,.pdf,.jpg,.jpeg,.png,.webp,.gif,.txt,.csv" multiple style="display:none">
        <button class="sd-ap-btn sd-ap-mic-btn" id="sd-ap-mic" title="Голосовой ввод — держи и говори&#10;Горячая клавиша: Alt+Пробел (зажми → говори → отпусти → отправит)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="9" y="3" width="6" height="11" rx="3"/>
            <path d="M5 11a7 7 0 0014 0M12 18v3M9 21h6"/>
          </svg>
        </button>
        <textarea class="sd-ap-textarea" placeholder="Напишите или скажите команду…" rows="1"></textarea>
        <button class="sd-ap-btn sd-ap-send-btn" id="sd-ap-send" title="Отправить">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
          </svg>
        </button>
      </div>
      <div id="sd-ap-sup-view" style="display:none;flex-direction:column;flex:1;min-height:0"></div>`;
  }

  private saveKeyFromPanel(): void {
    const input = this.panel?.querySelector<HTMLInputElement>('.sd-ap-key-input');
    const key = input?.value.trim() ?? '';
    if (!key) return;
    sessionStorage.setItem('sd_ai_key', key);
    this.aiKey = key;
    const keySetup = this.panel?.querySelector<HTMLElement>('.sd-ap-key-setup');
    if (keySetup) keySetup.style.display = 'none';
    this.addAssistantMessage('Ключ сохранён. Теперь я готова анализировать ваш магазин и отвечать на вопросы.');
  }

  clearChat(): void {
    if (!this.messagesEl) return;
    this.messagesEl.innerHTML = '';
    this.history = [];
    this.stopMsgTts();
    this.updateChatLayout();
    this.addAssistantMessage('Чат очищен. Чем могу помочь?');
  }

  // ── Morning brief ─────────────────────────────────────────────────────────────

  private maybeShowMorningBrief(): void {
    const today = new Date().toDateString();
    if (localStorage.getItem('sd_brief_shown') === today) return;
    localStorage.setItem('sd_brief_shown', today);
    const brief = this.buildInstantBrief();
    if (!brief) return;
    const ttsBtn = this.addAssistantMessage(brief);
    if (this.ttsEnabled && ttsBtn) this.startMsgTts(brief, ttsBtn);
  }

  private buildInstantBrief(): string {
    const alerts: string[] = [];

    try {
      const items: any[] = (window as any).stockModule?.items ?? [];
      const oos = items.filter((i: any) => i.stockTotal === 0);
      const low = items.filter((i: any) => i.stockTotal > 0 && i.stockTotal < 10);
      if (oos.length > 0) alerts.push(`**OOS (нет остатков):** ${oos.slice(0, 3).map((i: any) => i.name || i.offerId).join(', ')}${oos.length > 3 ? ` + ещё ${oos.length - 3}` : ''}`);
      if (low.length > 0) alerts.push(`**Критично мало (<10 ед):** ${low.slice(0, 3).map((i: any) => i.name || i.offerId).join(', ')}`);
    } catch { /* ignore */ }

    try {
      const tasks: any[] = (window as any).taskManagerModule?.tasks ?? [];
      const overdue = tasks.filter((t: any) => t.status !== 'done' && t.due_date && new Date(t.due_date) < new Date());
      if (overdue.length > 0) alerts.push(`**Просрочено задач: ${overdue.length}** — ${overdue.slice(0, 2).map((t: any) => `"${t.title}"`).join(', ')}`);
    } catch { /* ignore */ }

    try {
      const reviews: any[] = (window as any).reviewsModule?.reviews ?? [];
      const unanswered = reviews.filter((r: any) => !r.reply && r.stars <= 2);
      if (unanswered.length > 0) alerts.push(`**Негативных отзывов без ответа: ${unanswered.length}**`);
    } catch { /* ignore */ }

    if (!alerts.length) return '';
    return `**Утренний брифинг:**\n${alerts.join('\n')}\n\nЧто сделать прямо сейчас?`;
  }

  // ── Resize ─────────────────────────────────────────────────────────────────

  /**
   * Размер панели живёт в CSS-переменных --ap-w / --ap-h.
   * Ограничение по экрану делает сам CSS (clamp/min), поэтому при изменении
   * размера окна скрипт вообще ничего не пересчитывает — нечему дёргаться.
   */
  private setupResize(panel: HTMLElement): void {
    const handle = panel.querySelector<HTMLElement>('.sd-ap-resize-handle');
    if (!handle) return;

    const MIN_W = 320, MAX_W = 760, MIN_H = 320, MAX_H = 1200;

    const savedW = parseInt(localStorage.getItem('sd_ap_w') || '0', 10);
    const savedH = parseInt(localStorage.getItem('sd_ap_h') || '0', 10);
    if (savedW >= MIN_W && savedW <= MAX_W) panel.style.setProperty('--ap-w', savedW + 'px');
    else localStorage.removeItem('sd_ap_w');
    if (savedH >= MIN_H && savedH <= MAX_H) panel.style.setProperty('--ap-h', savedH + 'px');
    else localStorage.removeItem('sd_ap_h');

    let startX = 0, startY = 0, startW = 0, startH = 0;
    let rafId: number | null = null;
    let pendingW = 0, pendingH = 0;
    const isSidebar = () => panel.classList.contains('sidebar');

    const applySize = () => {
      rafId = null;
      panel.style.setProperty('--ap-w', pendingW + 'px');
      if (!isSidebar()) panel.style.setProperty('--ap-h', pendingH + 'px');
    };

    const startResize = (clientX: number, clientY: number) => {
      this.isResizing = true;
      startX = clientX; startY = clientY;
      const rect = panel.getBoundingClientRect();
      startW = pendingW = Math.round(rect.width);
      startH = pendingH = Math.round(rect.height);
      panel.classList.add('sd-ap-resizing');
      document.body.style.userSelect = 'none';
    };

    const track = (clientX: number, clientY: number) => {
      pendingW = Math.round(Math.max(MIN_W, Math.min(MAX_W, startW + (startX - clientX))));
      if (!isSidebar()) {
        pendingH = Math.round(Math.max(MIN_H, Math.min(MAX_H, startH + (startY - clientY))));
      }
      if (rafId === null) rafId = requestAnimationFrame(applySize);
    };

    const endResize = () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; applySize(); }
      panel.classList.remove('sd-ap-resizing');
      document.body.style.userSelect = '';
      this.isResizing = false;
      localStorage.setItem('sd_ap_w', String(pendingW));
      if (!isSidebar()) localStorage.setItem('sd_ap_h', String(pendingH));
      this.positionPanel();
    };

    const onMove = (e: MouseEvent) => track(e.clientX, e.clientY);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      endResize();
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startResize(e.clientX, e.clientY);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      startResize(t.clientX, t.clientY);
      const onTMove = (ev: TouchEvent) => { const tt = ev.touches[0]; track(tt.clientX, tt.clientY); };
      const onTEnd = () => {
        document.removeEventListener('touchmove', onTMove);
        document.removeEventListener('touchend', onTEnd);
        endResize();
      };
      document.addEventListener('touchmove', onTMove, { passive: false });
      document.addEventListener('touchend', onTEnd);
    }, { passive: false });
  }

  /**
   * Слежение за положением кнопки в доке.
   * Никаких MutationObserver на доке и ResizeObserver на самой панели: раньше
   * positionPanel() менял стили панели → срабатывал наблюдатель → снова
   * positionPanel(). Эта петля и давала дрожание при ресайзе окна.
   */
  private setupPositionTracking(): void {
    let rafId: number | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!this.isOpen || this.isResizing || rafId !== null) return;
      rafId = requestAnimationFrame(() => { rafId = null; this.positionPanel(); });
    };

    window.addEventListener('resize', () => {
      if (!this.isOpen) return;
      // На время «тряски» окна глушим анимации и тени — кадры перестают проседать
      this.panel?.classList.add('sd-ap-resizing');
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        this.panel?.classList.remove('sd-ap-resizing');
        this.positionPanel();
      }, 140);
      schedule();
    }, { passive: true });

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('orientationchange', schedule);

    // Док может менять высоту (мобильная раскладка) — следим только за ним
    const dock = document.querySelector('.dock') || document.querySelector('nav');
    if (dock && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(schedule).observe(dock);
    }
  }

  // ── Selection Context Chip ──────────────────────────────────────────────────

  private setupSelectionCtx(panel: HTMLElement): void {
    const chip    = panel.querySelector<HTMLElement>('#sd-ap-ctx-chip');
    const iconEl  = panel.querySelector<HTMLElement>('#sd-ap-ctx-icon');
    const labelEl = panel.querySelector<HTMLElement>('#sd-ap-ctx-label');
    const closeEl = panel.querySelector<HTMLElement>('#sd-ap-ctx-close');
    if (!chip || !labelEl) return;

    let dismissedLabel = '';

    const updateChip = () => {
      const ctx = selectionCtx.current;
      if (ctx.type === 'none' || ctx.label === dismissedLabel) {
        chip.style.display = 'none';
        return;
      }
      if (iconEl) iconEl.textContent = ctx.type === 'excel-cells' ? '📊' : '📋';
      labelEl.textContent = ctx.label;
      chip.style.display = 'flex';
    };

    selectionCtx.subscribe(updateChip);
    closeEl?.addEventListener('click', () => {
      dismissedLabel = selectionCtx.current.label;
      chip.style.display = 'none';
    });
  }

  // ── AI Cursor ────────────────────────────────────────────────────────────────

  private setupAiCursor(panel: HTMLElement): void {
    const btn = panel.querySelector<HTMLElement>('#sd-ap-cursor-btn');
    if (!btn) return;

    // Overlay — fixed div that follows the hovered element
    const overlay = document.createElement('div');
    overlay.id = 'sd-ai-cursor-overlay';
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:99998;border:2px solid #38bdf8;background:rgba(56,189,248,0.08);border-radius:3px;box-shadow:0 0 0 1px rgba(56,189,248,0.25),0 2px 12px rgba(56,189,248,0.15);display:none;transition:none';
    document.body.appendChild(overlay);
    this.aiCursorOverlay = overlay;

    let hovered: HTMLElement | null = null;

    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t === overlay || t.id === 'sd-ai-cursor-overlay') return;
      if (t.closest('#sd-assistant-panel')) return;
      hovered = t;
      const r = t.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = r.left + 'px';
      overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';
    };

    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as HTMLElement | null;
      if (to && to !== overlay && !to.closest('#sd-assistant-panel')) return;
      overlay.style.display = 'none';
      hovered = null;
    };

    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // Let assistant panel clicks through so the cursor button itself can deactivate
      if (t.closest('#sd-assistant-panel')) return;
      e.preventDefault();
      e.stopPropagation();
      if (!hovered) return;
      selectionCtx.set(this.extractAiCursorInfo(hovered));
      this.deactivateAiCursor();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.deactivateAiCursor();
    };

    btn.addEventListener('click', () => {
      if (this.aiCursorActive) {
        this.deactivateAiCursor();
        return;
      }
      this.aiCursorActive = true;
      btn.classList.add('active');
      document.body.classList.add('sd-ai-cursor-mode');
      document.addEventListener('mouseover', onOver, true);
      document.addEventListener('mouseout', onOut, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      this.aiCursorCleanup = () => {
        document.removeEventListener('mouseover', onOver, true);
        document.removeEventListener('mouseout', onOut, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
      };
    });
  }

  private deactivateAiCursor(): void {
    this.aiCursorActive = false;
    document.body.classList.remove('sd-ai-cursor-mode');
    if (this.aiCursorOverlay) this.aiCursorOverlay.style.display = 'none';
    this.panel?.querySelector('#sd-ap-cursor-btn')?.classList.remove('active');
    this.aiCursorCleanup?.();
    this.aiCursorCleanup = null;
  }

  private extractAiCursorInfo(el: HTMLElement): import('@/services/selectionContext').SelCtx {
    // Excel cell
    const td = el.closest('td[data-r][data-c]') as HTMLElement | null;
    if (td) {
      const r = +(td.dataset.r ?? 0);
      const c = +(td.dataset.c ?? 0);
      const col = String.fromCharCode(65 + c);
      const cellLabel = `${col}${r + 1}`;
      const val = (td.textContent ?? '').trim();
      return {
        type: 'excel-cells',
        label: `Ячейка ${cellLabel}${val ? ` · «${val.slice(0, 40)}»` : ''}`,
        prompt: `[КОНТЕКСТ: ячейка Excel ${cellLabel}]\n${val || '(пусто)'}`,
        data: { cell: cellLabel },
      };
    }

    // Any element — collect meaningful text
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    let text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text && el instanceof HTMLImageElement) text = el.alt || el.src.split('/').pop() || '';
    if (!text && (el as HTMLInputElement).value) text = (el as HTMLInputElement).value;

    const short = text.slice(0, 50);
    const typeHint = role || (['button', 'a', 'input', 'select', 'img', 'h1', 'h2', 'h3', 'td', 'li'].includes(tag) ? tag : '');
    const label = short ? `«${short}${text.length > 50 ? '…' : ''}»${typeHint ? ` (${typeHint})` : ''}` : `Элемент (${tag})`;

    return {
      type: 'text',
      label,
      prompt: `[КОНТЕКСТ: элемент страницы — ${typeHint || tag}]\n${text.slice(0, 600) || '(нет текста)'}`,
      data: { tag, role },
    };
  }

  // ── File Attachments ────────────────────────────────────────────────────────

  private setupFileAttach(panel: HTMLElement): void {
    this.fileInputEl = panel.querySelector<HTMLInputElement>('.sd-ap-file-input');
    const attachBtn = panel.querySelector<HTMLElement>('.sd-ap-attach-btn');
    attachBtn?.addEventListener('click', () => this.fileInputEl?.click());
    this.fileInputEl?.addEventListener('change', async () => {
      const files = Array.from(this.fileInputEl?.files ?? []);
      if (!files.length) return;
      for (const file of files) {
        try {
          const parsed = await this.parseFile(file);
          this.attachedFiles.push(parsed);
        } catch (e: unknown) {
          showToast(`Не удалось прочитать ${file.name}: ${(e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e}`, 'error');
        }
      }
      if (this.fileInputEl) this.fileInputEl.value = '';
      this.renderAttachChips();
    });
  }

  private async parseFile(file: File): Promise<AttachedFile> {
    const name = file.name;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';

    // Images
    if (['jpg','jpeg','png','webp','gif'].includes(ext)) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name, kind: 'image', imageDataUrl: reader.result as string, size: file.size });
        reader.onerror = () => reject(new Error('Ошибка чтения изображения'));
        reader.readAsDataURL(file);
      });
    }

    // Excel
    if (['xlsx','xls'].includes(ext)) {
      const { read, utils } = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = read(buf, { type: 'array' });
      const lines: string[] = [`Excel-файл «${name}»:`];
      for (const sname of wb.SheetNames) {
        const ws = wb.Sheets[sname];
        const csv = utils.sheet_to_csv(ws, { blankrows: false });
        lines.push(`\n[Лист: ${sname}]\n${csv.slice(0, 6000)}`);
      }
      return { name, kind: 'text', textContent: lines.join('\n'), size: file.size };
    }

    // Word
    if (['docx','doc'].includes(ext)) {
      // @ts-ignore — mammoth browser build has no type declarations
      const { default: mammoth } = await import('mammoth/mammoth.browser');
      const buf = await file.arrayBuffer();
      const result = await (mammoth as any).extractRawText({ arrayBuffer: buf });
      return { name, kind: 'text', textContent: `Word-документ «${name}»:\n${result.value.slice(0, 8000)}`, size: file.size };
    }

    // PDF — basic text extraction via PDF.js if available, else placeholder
    if (ext === 'pdf') {
      try {
        const pdfjsLib = (window as any).pdfjsLib;
        if (pdfjsLib) {
          const buf = await file.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
          let text = `PDF «${name}» (${pdf.numPages} стр.):\n`;
          for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map((item: any) => item.str).join(' ') + '\n';
          }
          return { name, kind: 'text', textContent: text.slice(0, 8000), size: file.size };
        }
      } catch { /* fall through */ }
      // Placeholder if PDF.js not available
      return { name, kind: 'text', textContent: `PDF-файл «${name}» прикреплён. Опишите что нужно извлечь — и я помогу.`, size: file.size };
    }

    // Plain text / CSV
    const text = await file.text();
    return { name, kind: 'text', textContent: `Файл «${name}»:\n${text.slice(0, 8000)}`, size: file.size };
  }

  private renderAttachChips(): void {
    const host = this.panel?.querySelector<HTMLElement>('#sd-ap-attach-chips');
    if (!host) return;
    if (!this.attachedFiles.length) { host.innerHTML = ''; return; }
    host.innerHTML = this.attachedFiles.map((f, i) => {
      const icon = f.kind === 'image' ? '🖼' : f.name.endsWith('.xlsx') || f.name.endsWith('.xls') ? '📊' : f.name.endsWith('.pdf') ? '📄' : '📝';
      const kb = Math.round(f.size / 1024);
      return `<div class="sd-ap-chip" data-idx="${i}">${icon} <span>${f.name}</span><span class="sd-ap-chip-size">${kb}кб</span><button class="sd-ap-chip-del" data-idx="${i}">×</button></div>`;
    }).join('');
    host.querySelectorAll<HTMLButtonElement>('.sd-ap-chip-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = +(btn.dataset.idx ?? '-1');
        this.attachedFiles.splice(idx, 1);
        this.renderAttachChips();
      });
    });
  }

  // ── Quick actions: fetch store data → AI analysis ─────────────────────────

  private async handleQuickAction(action: string): Promise<void> {
    const analyticsModule = (window as any).analyticsModule;

    switch (action) {
      case 'analytics30': {
        let context = 'Раздел аналитики открыт.';
        if (analyticsModule) {
          context = 'Данные аналитики доступны в разделе. Текущая страница: analytics.';
        }
        await this.sendMessage(
          `[БЫСТРОЕ ДЕЙСТВИЕ: Аналитика за 30 дней]\n${context}\n\n` +
          'Проведи полный анализ магазина за последние 30 дней. ' +
          'Найди главные тренды, риски, топ и аутсайдеров. ' +
          'Дай 3 конкретных действия для роста выручки.'
        );
        break;
      }
      case 'stockRisk': {
        await this.sendMessage(
          '[БЫСТРОЕ ДЕЙСТВИЕ: Анализ рисков остатков]\n' +
          'Я на странице "Остатки". ' +
          'Объясни как найти товары с критически низким запасом (менее 14 дней) в SimaDesk, ' +
          'какие риски несёт out-of-stock и что конкретно нужно сделать прямо сейчас.'
        );
        (window as any).app?.navigateTo?.('stock');
        break;
      }
      case 'ordersCheck': {
        await this.sendMessage(
          '[БЫСТРОЕ ДЕЙСТВИЕ: Проверка заказов]\n' +
          'Помоги проверить текущие заказы. ' +
          'Что нужно проверить в разделе заказов прямо сейчас? ' +
          'На какие статусы обратить внимание, какие дедлайны критичны? ' +
          'Открой раздел заказов и объясни как работать с ним эффективно.'
        );
        (window as any).app?.navigateTo?.('orders');
        break;
      }
      case 'dailyCheck': {
        await this.sendMessage(
          '[БЫСТРОЕ ДЕЙСТВИЕ: Дневной чеклист]\n' +
          'Составь подробный чеклист на сегодня для менеджера маркетплейсов. ' +
          'Что конкретно нужно проверить в SimaDesk, в каком порядке и почему это важно. ' +
          'Укажи приоритеты и красные флаги.'
        );
        break;
      }
      case 'priceAnalysis': {
        await this.sendMessage(
          '[БЫСТРОЕ ДЕЙСТВИЕ: Анализ цен и репрайсер]\n' +
          'Объясни как правильно настроить репрайсер в SimaDesk для максимальной прибыли. ' +
          'Какие стратегии ценообразования использовать? ' +
          'Как не потерять маржу участвуя в акциях маркетплейса? ' +
          'Как посчитать минимальную цену с учётом всех расходов?'
        );
        (window as any).app?.navigateTo?.('repricer');
        break;
      }
      case 'howTo': {
        await this.sendMessage(
          '[БЫСТРОЕ ДЕЙСТВИЕ: Обучение SimaDesk]\n' +
          'Дай полный гид по SimaDesk: с чего начать новому пользователю, ' +
          'какие разделы самые важные, как настроить систему для максимальной эффективности, ' +
          'какие фичи используют опытные менеджеры.'
        );
        break;
      }
      case 'reviewsCheck': {
        await this.sendMessage(
          '[БЫСТРОЕ ДЕЙСТВИЕ: Работа с отзывами]\n' +
          'Объясни стратегию работы с отзывами на маркетплейсах: ' +
          'как отвечать на негатив, как стимулировать положительные отзывы, ' +
          'как отзывы влияют на позиции в выдаче и что делать с рейтингом ниже 4.5.'
        );
        (window as any).app?.navigateTo?.('reviews');
        break;
      }
      case 'unitEconomy': {
        this.addUnitEconomicsCard();
        break;
      }
      case 'seoAdvice': {
        await this.sendMessage(
          '[БЫСТРОЕ ДЕЙСТВИЕ: SEO карточек]\n' +
          'Дай конкретные инструкции по SEO-оптимизации карточек товаров: ' +
          'как составить заголовок, описание, характеристики. ' +
          'Какие ключевые слова собирать, где их размещать, ' +
          'как отслеживать позиции и что влияет на ранжирование больше всего.'
        );
        (window as any).app?.navigateTo?.('products-hub');
        break;
      }
      case 'adStrategy': {
        await this.sendMessage(
          '[БЫСТРОЕ ДЕЙСТВИЕ: Стратегия рекламы]\n' +
          'Объясни как правильно запускать и оптимизировать рекламу на маркетплейсах: ' +
          'с каких форматов начинать на Ozon и WB, как контролировать ДРР, ' +
          'когда масштабировать, когда останавливать, как анализировать эффективность по дням недели.'
        );
        break;
      }
      case 'risks': {
        await this.sendMessage(
          '[БЫСТРОЕ ДЕЙСТВИЕ: Поиск рисков]\n' +
          'Проведи полный аудит рисков моего магазина прямо сейчас. ' +
          'Перечисли все категории рисков которые нужно проверить: ' +
          'остатки, заказы, цены, отзывы, реклама, документы, блокировки. ' +
          'Для каждого риска — как его обнаружить в SimaDesk и что сделать.'
        );
        break;
      }
      case 'growthPlan': {
        await this.sendMessage(
          '[БЫСТРОЕ ДЕЙСТВИЕ: План роста]\n' +
          'Составь пошаговый план роста продаж на маркетплейсах. ' +
          'Разбей на этапы: что сделать в первую неделю, в первый месяц, в первые 3 месяца. ' +
          'Конкретные действия, метрики для отслеживания, инструменты SimaDesk для каждого этапа.'
        );
        break;
      }
    }
  }

  // ── Task handling ─────────────────────────────────────────────────────────────

  private parseTaskAction(reply: string): TaskAction | null {
    const match = reply.match(/\{[\s\S]*?"action"\s*:\s*"(?:create_task|create_tasks|suggest_task)"[\s\S]*?\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as TaskAction;
    } catch { return null; }
  }

  private async handleTaskAction(ta: TaskAction): Promise<void> {
    if (ta.action === 'create_task') {
      await this.createTaskFromAI(ta);
    } else if (ta.action === 'create_tasks' && ta.tasks?.length) {
      for (const t of ta.tasks) {
        await this.createTaskFromAI({ action: 'create_task', ...t, priority: t.priority as any });
      }
      this.addAssistantMessage(`Создано задач: ${ta.tasks.length}. Откройте раздел Задачи для просмотра.`);
    } else if (ta.action === 'suggest_task') {
      this.addSuggestTaskCard(ta);
    }
  }

  private async createTaskFromAI(data: Partial<TaskAction>): Promise<void> {
    try {
      const { taskDb } = await import('@/services/taskDb');
      const task = await taskDb.createTask({
        title:          data.title || 'Задача от Симы',
        description:    data.description || '',
        status:         'todo',
        priority:       (data.priority as any) || 'none',
        scheduled_date: null,
        due_date:       data.due_date || null,
        due_time:       data.due_time || null,
        end_time:       null,
        all_day:        !data.due_time,
        tags:           'Сима',
        sort_order:     9999,
        parent_id:      null,
        assignee_id:    null,
      });
      const ttsBtn = this.addAssistantMessage(
        `Задача создана: **${task.title}**${data.due_date ? ` · срок: ${data.due_date}` : ''}\n\nНайдёте её в разделе Задачи.`
      );
      if (this.ttsEnabled && ttsBtn) this.startMsgTts(`Задача создана: ${task.title}`, ttsBtn);
      (window as any).taskManagerModule?.load?.();
    } catch {
      this.addAssistantMessage('Не удалось создать задачу — проверьте подключение. Можете добавить её вручную в разделе Задачи.');
    }
  }

  private addSuggestTaskCard(ta: TaskAction): void {
    if (!this.messagesEl) return;
    const priorityLabel: Record<string, string> = { red: '🔴 Срочно', yellow: '🟡 Важно', blue: '🔵 Инфо', none: '' };
    const el = document.createElement('div');
    el.className = 'sd-ap-msg assistant';
    el.innerHTML = `
      <div class="sd-ap-msg-avatar">С</div>
      <div class="sd-ap-msg-bubble">
        <div style="font-size:11px;color:rgba(200,160,255,0.8);font-weight:600;margin-bottom:4px">Предлагаю создать задачу:</div>
        <div class="sd-ap-task-suggest">
          <div class="sd-ap-task-suggest-title">${esc(ta.title || '')}</div>
          ${ta.description ? `<div class="sd-ap-task-suggest-desc">${esc(ta.description)}</div>` : ''}
          ${ta.priority && ta.priority !== 'none' ? `<div class="sd-ap-task-suggest-priority">${priorityLabel[ta.priority] || ''}</div>` : ''}
          <button class="sd-ap-task-suggest-btn">+ Создать задачу</button>
        </div>
      </div>`;
    el.querySelector('.sd-ap-task-suggest-btn')?.addEventListener('click', async (e) => {
      (e.currentTarget as HTMLElement).textContent = 'Создаётся…';
      (e.currentTarget as HTMLButtonElement).disabled = true;
      await this.createTaskFromAI(ta);
      el.querySelector<HTMLElement>('.sd-ap-task-suggest')!.style.opacity = '0.5';
    });
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  // ── Per-message TTS ──────────────────────────────────────────────────────────

  private startMsgTts(text: string, btn: HTMLElement): void {
    ttsStop();
    if (this.speakingBtn && this.speakingBtn !== btn) {
      this.speakingBtn.classList.remove('speaking');
    }
    btn.classList.add('speaking');
    this.btn?.classList.add('speaking');
    this.speakingBtn = btn;
    this.setStatus('Озвучиваю…', 'speaking');
    ttsSpeak(text, () => {
      btn.classList.remove('speaking');
      if (this.speakingBtn === btn) {
        this.speakingBtn = null;
        this.btn?.classList.remove('speaking');
        if (!this.isLoading) this.setStatus('Готова');
      }
    }, this.ttsRate, this.ttsVoiceName);
  }

  private stopMsgTts(): void {
    ttsStop();
    if (this.speakingBtn) {
      this.speakingBtn.classList.remove('speaking');
      this.speakingBtn = null;
    }
    this.btn?.classList.remove('speaking');
    if (!this.isLoading) this.setStatus('Готова');
  }

  // ── TTS toggle ────────────────────────────────────────────────────────────────

  private toggleTts(): void {
    this.ttsEnabled = !this.ttsEnabled;
    localStorage.setItem('sd_tts_enabled', this.ttsEnabled ? 'true' : 'false');
    if (!this.ttsEnabled) ttsStop();
    this.updateTtsBtn();
  }

  private updateTtsBtn(): void {
    const btn = this.panel?.querySelector<HTMLElement>('.sd-ap-tts-btn');
    if (!btn) return;
    btn.classList.toggle('tts-active', this.ttsEnabled);
    btn.title = this.ttsEnabled ? 'Озвучка включена (нажмите чтобы выключить)' : 'Озвучка выключена (нажмите чтобы включить)';
  }

  // ── Voice onboarding ──────────────────────────────────────────────────────────

  private showVoiceOnboarding(): void {
    if (this.voiceOnboarded || !this.panel) return;
    this.voiceOnboarded = true;
    localStorage.setItem('sd_voice_onboarded', '1');

    const overlay = document.createElement('div');
    overlay.className = 'sd-ap-onboarding';
    overlay.innerHTML = `
      <div class="sd-ap-ob-card">
        <div class="sd-ap-ob-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="32" height="32">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>
          </svg>
        </div>
        <h4>Включить голосовые функции?</h4>
        <p>Сима будет озвучивать ответы и принимать голосовые команды. Потребуется разрешение на микрофон.</p>
        <div class="sd-ap-ob-btns">
          <button class="sd-ap-ob-yes">Включить</button>
          <button class="sd-ap-ob-no">Не сейчас</button>
        </div>
      </div>`;

    overlay.querySelector('.sd-ap-ob-yes')?.addEventListener('click', async () => {
      overlay.remove();
      this.ttsEnabled = true;
      localStorage.setItem('sd_tts_enabled', 'true');
      this.updateTtsBtn();
      // Request mic permission
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      } catch { /* user denied mic — voice input won't work but TTS will */ }
      this.addAssistantMessage('Голосовые функции включены! Нажмите 🎤 для голосового ввода, и я буду озвучивать ответы.');
    });

    overlay.querySelector('.sd-ap-ob-no')?.addEventListener('click', () => {
      overlay.remove();
      this.ttsEnabled = false;
      localStorage.setItem('sd_tts_enabled', 'false');
      this.updateTtsBtn();
    });

    this.panel.appendChild(overlay);
  }

  private setupVoiceHotkey(): void {
    // Alt+Space — hold to record, release to send
    // Fires only when focus is NOT inside an input/textarea (to avoid blocking typing)
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!e.altKey || e.key !== ' ') return;
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement as HTMLElement)?.isContentEditable) return;
      if (this.voiceHotkeyHeld) return; // already held
      e.preventDefault();
      this.voiceHotkeyHeld = true;
      this.voiceSendOnEnd = true;
      if (!this.isOpen) this.openPanel();
      // Small delay so panel renders before we start listening
      setTimeout(() => {
        if (this.voiceHotkeyHeld) this.startVoice();
      }, 150);
    });

    document.addEventListener('keyup', (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.key !== 'Alt') return;
      if (!this.voiceHotkeyHeld) return;
      // Only trigger on Space release (Alt release alone = accidental)
      if (e.key !== ' ' && e.key !== 'Alt') return;
      this.voiceHotkeyHeld = false;
      if (this.isListening) {
        // stopVoice will trigger onresult → isFinal → handleSend via voiceSendOnEnd
        this.recognition?.stop();
      }
    });
  }

  togglePanel(): void {
    if (this.isOpen) this.closePanel();
    else this.openPanel();
  }

  openPanel(): void {
    if (!this.panel) return;

    // Position panel above the dock icon dynamically
    this.positionPanel();

    this.isOpen = true;
    this.panel.classList.add('open');
    this.btn?.classList.add('active');
    this.textareaEl?.focus();
    this.scrollToBottom();
    setTimeout(() => this.maybeShowMorningBrief(), 800);
    if (!this.voiceOnboarded) {
      setTimeout(() => this.showVoiceOnboarding(), 600);
    }
  }

  /** Последние применённые координаты — чтобы не трогать DOM без нужды. */
  private lastPos = '';

  /**
   * Привязка панели к кнопке в доке. Пишет только CSS-переменные
   * (--ap-bottom / --ap-right / --arrow-left): ширину и высоту зажимает сам CSS,
   * поэтому вызов дешёвый и не вызывает каскадных перерасчётов.
   */
  private positionPanel(): void {
    if (!this.panel || !this.btn) return;

    // Полноэкранный редактор документов — панель становится боковой
    const docsFullscreen = !!document.querySelector('.docs-shell.docs-fullscreen');
    const modeTabs = this.panel.querySelector<HTMLElement>('#sd-ap-mode-tabs');
    if (modeTabs) modeTabs.style.display = docsFullscreen ? 'none' : '';

    if (docsFullscreen) {
      this.panel.classList.add('sidebar');
      this.lastPos = 'sidebar';
      return;
    }
    this.panel.classList.remove('sidebar');

    const btn = this.btn.getBoundingClientRect();
    const panelW = this.panel.getBoundingClientRect().width || 400;
    const gap = 12;

    const bottom = Math.round(Math.max(8, window.innerHeight - btn.top + gap));
    const right  = Math.round(Math.max(8, window.innerWidth - btn.right));

    const btnCenterX = btn.left + btn.width / 2;
    const panelLeft  = (window.innerWidth - right) - panelW;
    const originXpx  = btnCenterX - panelLeft;
    const originXpct = Math.min(100, Math.max(0, (originXpx / panelW) * 100));
    const arrowLeft  = Math.round(Math.min(panelW - 28, Math.max(12, originXpx - 7)));

    const key = `${bottom}|${right}|${arrowLeft}|${originXpct.toFixed(1)}`;
    if (key === this.lastPos) return;   // ничего не изменилось — не пишем в DOM
    this.lastPos = key;

    this.panel.style.setProperty('--ap-bottom', bottom + 'px');
    this.panel.style.setProperty('--ap-right', right + 'px');
    this.panel.style.setProperty('--arrow-left', arrowLeft + 'px');
    this.panel.style.transformOrigin = `${originXpct}% 100%`;
  }

  // ── Support chat ──────────────────────────────────────────────────────────────

  openSupportChat(): void {
    if (this.isOpen) {
      this.switchSupportMode('support');
    } else {
      this.togglePanel();
      setTimeout(() => this.switchSupportMode('support'), 350);
    }
  }

  private switchSupportMode(mode: 'ai' | 'support'): void {
    if (!this.panel) return;
    this.supportMode = mode;

    // Update tabs
    this.panel.querySelectorAll<HTMLElement>('.sd-ap-mode-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.mode === mode);
    });

    const aiContent = this.panel.querySelector<HTMLElement>('.sd-ap-key-setup, .sd-ap-quick-actions, .sd-ap-hints, .sd-ap-page-actions, .sd-ap-messages, .sd-ap-attach-chips, .sd-ap-input-area');
    const supView = this.panel.querySelector<HTMLElement>('#sd-ap-sup-view');

    // Show/hide by class on a wrapper — use attribute selector on all AI-only elements
    const aiEls = this.panel.querySelectorAll<HTMLElement>(
      '.sd-ap-scroll, .sd-ap-attach-chips, .sd-ap-input-area'
    );
    aiEls.forEach(el => { el.style.display = mode === 'ai' ? '' : 'none'; });
    void aiContent; // suppress unused warning

    if (supView) {
      supView.style.display = mode === 'support' ? 'flex' : 'none';
      if (mode === 'support') {
        this.supportUnread = 0;
        this.updateSupportBadge();
        this.renderSupportView(supView);
      }
    }

    // Опрос НЕ останавливаем при уходе на вкладку Симы — иначе ответ оператора
    // остаётся незамеченным. В фоне он только считает непрочитанные.
    if (mode === 'ai' && this.supportChatId) this.startSupportPolling();
  }

  /** Счётчик непрочитанных ответов оператора на вкладке «Поддержка». */
  private supportUnread = 0;

  private updateSupportBadge(): void {
    const dot = this.panel?.querySelector<HTMLElement>('#sd-ap-sup-dot');
    if (!dot) return;
    if (this.supportUnread > 0 && this.supportMode !== 'support') {
      dot.textContent = this.supportUnread > 9 ? '9+' : String(this.supportUnread);
      dot.style.display = '';
    } else {
      dot.style.display = 'none';
    }
  }

  /** Экран ошибки поддержки с кнопкой повтора — вместо молчаливого пустого чата. */
  private showSupportError(container: HTMLElement, message: string): void {
    container.innerHTML = `
      <div class="sd-sup-error">
        <div style="font-size:1.8rem">⚠️</div>
        <div>${esc(message)}</div>
        <button id="sd-sup-retry">Повторить</button>
      </div>`;
    container.querySelector('#sd-sup-retry')?.addEventListener('click', () => {
      this.renderSupportView(container);
    });
  }

  private renderSupportView(container: HTMLElement): void {
    if (this.supportChatId && !this.supportChatClosed) {
      this.renderSupportChat(container);
      // Restore message history from server if not yet loaded
      if (!this.supportMessages.length) {
        supportChatService.getMyChat().then(chat => {
          // undefined = запрос не прошёл (сеть/права). Чат не трогаем, показываем ошибку.
          if (chat === undefined) {
            this.showSupportError(container, supportChatService.lastError ?? 'Нет связи с сервером');
            return;
          }
          if (!chat || chat.id !== this.supportChatId) {
            // Chat no longer active on server — clear stale localStorage
            localStorage.removeItem('sd_sup_chat_id');
            localStorage.removeItem('sd_sup_reason');
            this.supportChatId = null;
            this.supportChatClosed = false;
            this.renderSupportReasonSelect(container);
            return;
          }
          this.supportMessages = chat.messages ?? [];
          this.supportLastMsgTime = this.supportMessages.at(-1)?.created_at ?? null;
          this.renderSupportMessages();
          this.startSupportPolling();
        }).catch(() => {});
      } else {
        this.startSupportPolling();
      }
    } else {
      this.renderSupportReasonSelect(container);
    }
  }

  private renderSupportReasonSelect(container: HTMLElement): void {
    const reasons = Object.entries(SUPPORT_REASONS);
    container.innerHTML = `
      <div class="sd-sup-reason-screen">
        <div class="sd-sup-reason-title">Выберите тему обращения</div>
        <div class="sd-sup-reason-sub">Оператор поддержки ответит вам в этом чате</div>
        <div class="sd-sup-reason-grid">
          ${reasons.map(([key, label]) =>
            `<button class="sd-sup-reason-btn" data-reason="${key}">${label}</button>`
          ).join('')}
        </div>
        <div class="sd-sup-warn">⚠️ После завершения диалога история чата будет удалена</div>
      </div>`;

    container.querySelectorAll<HTMLElement>('.sd-sup-reason-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const reason = btn.dataset.reason!;
        this.supportReason = reason;
        try {
          this.supportChatId = await supportChatService.createChat(reason);
          localStorage.setItem('sd_sup_chat_id', this.supportChatId);
          localStorage.setItem('sd_sup_reason', reason);
          this.supportMessages = [];
          this.supportLastMsgTime = null;
          this.supportChatClosed = false;
          this.supContextSent = false;
          this.supAckShown = false;
          this.renderSupportChat(container);
          this.startSupportPolling();
        } catch (e) {
          console.error('[Support] createChat:', e);
          this.showSupportError(container, 'Не удалось создать чат. ' + supportErrorText(e));
        }
      });
    });
  }

  private renderSupportChat(container: HTMLElement): void {
    const reasonLabel = SUPPORT_REASONS[this.supportReason] ?? this.supportReason;
    container.innerHTML = `
      <div class="sd-sup-chat-header">
        <div class="sd-sup-chat-title">
          <span>Поддержка SimaDesk</span>
          <span class="sd-sup-chat-reason">${reasonLabel}</span>
        </div>
        <button class="sd-sup-close-btn" id="sd-sup-close-btn" title="Завершить диалог">Завершить</button>
      </div>
      <div class="sd-sup-messages" id="sd-sup-messages"></div>
      <div class="sd-sup-attach-chips" id="sd-sup-attach-chips"></div>
      <div id="sd-sup-cooldown"></div>
      <div class="sd-sup-input-area">
        <button class="sd-sup-attach-btn" id="sd-sup-attach-btn" title="Прикрепить файл">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="18" height="18">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </button>
        <input type="file" id="sd-sup-file-input" accept=".xlsx,.xls,.docx,.doc,.pdf,.jpg,.jpeg,.png,.webp,.gif,.txt,.csv" multiple style="display:none">
        <textarea class="sd-sup-textarea" id="sd-sup-textarea" placeholder="Напишите сообщение…" rows="1"></textarea>
        <button class="sd-sup-send-btn" id="sd-sup-send-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
          </svg>
        </button>
      </div>`;

    this.renderSupportMessages();
    this.bindSupportChatEvents(container);
    this.startSupportPolling();
  }

  private supAttachFiles: SupportAttachment[] = [];

  private bindSupportChatEvents(container: HTMLElement): void {
    const textarea = container.querySelector<HTMLTextAreaElement>('#sd-sup-textarea');
    const sendBtn  = container.querySelector('#sd-sup-send-btn');
    const closeBtn = container.querySelector('#sd-sup-close-btn');
    const attachBtn = container.querySelector('#sd-sup-attach-btn');
    const fileInput = container.querySelector<HTMLInputElement>('#sd-sup-file-input');

    this.supAttachFiles = [];

    const doSend = async () => {
      if (!textarea || !this.supportChatId) return;
      const text = textarea.value.trim();
      if (!text && this.supAttachFiles.length === 0) return;

      // Штраф считаем только пока ждём оператора: последнее сообщение — наше
      const pendingWait = this.spamGuard.register({
        text,
        hasAttachment: this.supAttachFiles.length > 0,
        awaitingOperator: this.supportMessages.length > 0
          && this.supportMessages.at(-1)?.sender_role === 'user',
        now: Date.now(),
      });

      // Контекст темы/раздела — однократно в первом сообщении сессии чата
      let textToSend = text;
      if (!this.supContextSent) {
        this.supContextSent = true;
        const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
        const section = (location.pathname.split('/').filter(Boolean)[0] || 'home');
        textToSend = `[🤖 АВТОКОНТЕКСТ: тема=${isDark ? 'тёмная' : 'светлая'}, раздел=${section}]\n${text}`;
      }

      textarea.value = '';
      textarea.style.height = '';
      const attachSnap = [...this.supAttachFiles];
      this.supAttachFiles = [];
      this.renderSupAttachChips(container);
      const optId = `opt-${Date.now()}`;
      // Show message immediately without waiting for server (display original text, not context-enriched)
      this.supportMessages = [...this.supportMessages, {
        id: optId,
        sender_role: 'user',
        content: text,
        attachments: attachSnap,
        created_at: new Date().toISOString(),
      }];
      this.supportPending.add(optId);
      this.renderSupportMessages();
      try {
        await supportChatService.sendMessage(this.supportChatId, textToSend, attachSnap);
        this.supportPending.delete(optId);
        // Перечитываем весь диалог — подтверждение, что сообщение реально в базе
        const msgs = await supportChatService.getMessagesSince(this.supportChatId);
        if (msgs.length) {
          this.supportMessages = msgs;
          this.supportLastMsgTime = msgs[msgs.length - 1]?.created_at ?? null;
          this.supportFailed.clear();
        }
        this.renderSupportMessages();
      } catch (err) {
        const msg = supportErrorText(err);
        console.error('[Support] Ошибка отправки:', err);
        this.supportPending.delete(optId);
        this.supportFailed.set(optId, msg);
        this.renderSupportMessages();
        showToast('Сообщение не отправлено: ' + msg, 'error');
      }

      // Spam detected — show one-time ack banner (don't block sending)
      if (pendingWait > 0 && !this.supAckShown) {
        this.supAckShown = true;
        this.showSupAck();
      }
    };

    textarea?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    textarea?.addEventListener('input', () => {
      if (textarea) { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px'; }
      if (textarea?.value.trim()) this.signalTyping();
    });
    sendBtn?.addEventListener('click', doSend);

    // Action buttons injected by admin AI (e.g. toggle_theme_off)
    const messagesEl = container.querySelector<HTMLElement>('#sd-sup-messages');
    messagesEl?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.sd-sup-action-btn');
      if (btn?.dataset.action) this.executeSupportAction(btn.dataset.action);
    });

    closeBtn?.addEventListener('click', () => this.confirmCloseSupport(container));

    attachBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      const files = Array.from(fileInput?.files ?? []);
      if (!files.length) return;
      files.forEach(file => {
        if (file.size > 5 * 1024 * 1024) { showToast('Файл слишком большой (макс 5 МБ)', 'error'); return; }
        const reader = new FileReader();
        if (file.type.startsWith('image/')) {
          reader.onload = e => {
            this.supAttachFiles.push({ name: file.name, kind: 'image', data: e.target?.result as string, size: file.size });
            this.renderSupAttachChips(container);
          };
          reader.readAsDataURL(file);
        } else {
          reader.onload = e => {
            this.supAttachFiles.push({ name: file.name, kind: 'text', data: e.target?.result as string, size: file.size });
            this.renderSupAttachChips(container);
          };
          reader.readAsText(file);
        }
      });
      if (fileInput) fileInput.value = '';
    });
  }

  private renderSupAttachChips(container: HTMLElement): void {
    const chips = container.querySelector('#sd-sup-attach-chips');
    if (!chips) return;
    chips.innerHTML = this.supAttachFiles.map((f, i) =>
      `<div class="sd-ap-attach-chip">${f.kind === 'image' ? '🖼' : '📎'} ${f.name}
        <button class="sd-ap-attach-chip-rm" data-idx="${i}">×</button>
      </div>`
    ).join('');
    chips.querySelectorAll<HTMLElement>('.sd-ap-attach-chip-rm').forEach(btn => {
      btn.addEventListener('click', () => {
        this.supAttachFiles.splice(+(btn.dataset.idx!), 1);
        this.renderSupAttachChips(container);
      });
    });
  }

  /** id оптимистичных сообщений: ещё отправляются / не отправились. */
  private supportPending = new Set<string>();
  private supportFailed  = new Map<string, string>();

  // ── Индикатор набора ────────────────────────────────────────────────────────

  /** Печатает ли собеседник (оператор или AI-ответчик) прямо сейчас. */
  private supportPeerTyping = false;
  /** Когда последний раз отправляли серверу «я печатаю» — не чаще раза в 2.5 с. */
  private supportTypingSentAt = 0;

  private signalTyping(): void {
    if (!this.supportChatId) return;
    const now = Date.now();
    if (now - this.supportTypingSentAt < 2500) return;
    this.supportTypingSentAt = now;
    void supportChatService.setTyping(this.supportChatId);
  }

  // ── Антиспам в ожидании оператора ───────────────────────────────────────────
  //
  // Цель — гасить именно спам (короткие сообщения очередью, дубли), но не мешать
  // подробно описывать проблему: длинный текст и вложения не штрафуются.

  private spamGuard = new SupportSpamGuard();
  /** Показали ли уже баннер «сообщения дошли» в текущей серии ожидания. */
  private supAckShown = false;
  /** Уже ли инжектировали контекст темы/раздела в текущей сессии чата. */
  private supContextSent = false;

  /** Оператор ответил — все штрафы снимаются. */
  private resetSpamGuard(): void {
    this.spamGuard.reset();
    this.supAckShown = false;
    this.renderCooldown();
  }

  private renderCooldown(): void {
    const box = this.panel?.querySelector<HTMLElement>('#sd-sup-cooldown');
    const area = this.panel?.querySelector<HTMLElement>('.sd-sup-input-area');
    if (!box) return;
    // Never lock the input — just clear the cooldown box
    area?.classList.remove('locked');
    box.innerHTML = '';
  }

  private showSupAck(): void {
    const box = this.panel?.querySelector<HTMLElement>('#sd-sup-cooldown');
    if (!box) return;
    box.innerHTML = `
      <div class="sd-sup-ack">
        <span class="sd-sup-ack-icon">✅</span>
        <span>Сообщения дошли — оператор уже в пути. Вы можете продолжать писать.</span>
      </div>`;
  }

  private renderSupportMessages(): void {
    const el = this.panel?.querySelector<HTMLElement>('#sd-sup-messages');
    if (!el) return;

    const typingHtml = this.supportPeerTyping
      ? `<div class="sd-sup-typing">
           <span class="sd-sup-typing-dots"><i></i><i></i><i></i></span>
           <span>Поддержка печатает…</span>
         </div>`
      : '';

    if (this.supportMessages.length === 0) {
      el.innerHTML = typingHtml ||
        `<div class="sd-sup-empty">Напишите ваш вопрос — оператор ответит в ближайшее время</div>`;
      return;
    }
    el.innerHTML = this.supportMessages.map(m => {
      const isUser = m.sender_role === 'user';
      const time = supportChatService.fmtTime(m.created_at);
      const failed = this.supportFailed.get(m.id);
      const pending = this.supportPending.has(m.id);
      const attachHtml = (m.attachments ?? []).map(a =>
        a.kind === 'image'
          ? `<img src="${esc(a.data)}" alt="${esc(a.name)}" class="sd-sup-msg-img">`
          : `<div class="sd-sup-msg-file">📎 ${esc(a.name)}</div>`
      ).join('');
      const meta = failed ? `⚠️ ${esc(failed)}` : pending ? 'Отправка…' : `${isUser ? '' : 'Поддержка · '}${time}`;
      const cls = `sd-sup-msg ${isUser ? 'user' : 'admin'}${failed ? ' failed' : ''}${pending ? ' pending' : ''}`;

      // Strip silent context tag from display
      let displayContent = m.content.replace(/\[🤖 АВТОКОНТЕКСТ:[^\]]*\]\n?/g, '').trim();

      // Parse support_action JSON from admin messages
      let actionHtml = '';
      if (!isUser) {
        const actionMatch = displayContent.match(/\{"support_action":"([^"]+)","label":"([^"]+)"\}/);
        if (actionMatch) {
          displayContent = displayContent.replace(actionMatch[0], '').trim();
          const aName = actionMatch[1];
          const aLabel = actionMatch[2];
          actionHtml = `<button class="sd-sup-action-btn" data-action="${esc(aName)}">${esc(aLabel)}</button>`;
        }
      }

      return `<div class="${cls}">
        <div class="sd-sup-bubble">${esc(displayContent).replace(/\n/g, '<br>')}${attachHtml}${actionHtml}</div>
        <div class="sd-sup-msg-time">${meta}</div>
      </div>`;
    }).join('') + typingHtml;
    el.scrollTop = el.scrollHeight;
  }

  private confirmCloseSupport(container: HTMLElement): void {
    container.innerHTML = `
      <div class="sd-sup-confirm-close">
        <div class="sd-sup-confirm-icon">⚠️</div>
        <div class="sd-sup-confirm-title">Завершить диалог?</div>
        <div class="sd-sup-confirm-desc">История переписки будет безвозвратно удалена. Сохраните важную информацию заранее.</div>
        <div class="sd-sup-confirm-btns">
          <button class="sd-sup-confirm-yes">Да, завершить</button>
          <button class="sd-sup-confirm-no">Отмена</button>
        </div>
      </div>`;
    container.querySelector('.sd-sup-confirm-yes')?.addEventListener('click', async () => {
      if (this.supportChatId) {
        try { await supportChatService.closeMyChat(this.supportChatId); } catch {}
      }
      this.stopSupportPolling();
      this.supportChatId = null;
      this.supportMessages = [];
      this.supportLastMsgTime = null;
      this.supportChatClosed = false;
      localStorage.removeItem('sd_sup_chat_id');
      localStorage.removeItem('sd_sup_reason');
      this.renderSupportReasonSelect(container);
    });
    container.querySelector('.sd-sup-confirm-no')?.addEventListener('click', () => {
      this.renderSupportChat(container);
    });
  }

  /**
   * Опрос новых сообщений. Работает и когда открыта вкладка Симы, и когда панель
   * закрыта — тогда просто копит счётчик непрочитанных на вкладке «Поддержка».
   * Статус чата (не закрыл ли оператор) проверяется реже, чем сообщения.
   */
  private startSupportPolling(): void {
    this.stopSupportPolling();
    if (!this.supportChatId) return;

    this.supportPollTimer = setInterval(async () => {
      if (!this.supportChatId) { this.stopSupportPolling(); return; }

      // Первая загрузка истории не считается «новыми» сообщениями
      const isBaseline = this.supportLastMsgTime === null && this.supportMessages.length === 0;
      // Один запрос: сообщения + статус + печатает ли собеседник
      const res = await supportChatService.poll(this.supportChatId, this.supportLastMsgTime);
      if (!res) return;            // ошибка сети — состояние чата не трогаем

      const viewing = this.supportMode === 'support' && this.isOpen;

      if (res.peer_typing !== this.supportPeerTyping) {
        this.supportPeerTyping = res.peer_typing;
        if (viewing) this.renderSupportMessages();
      }

      const newMsgs = res.messages;
      if (newMsgs.length > 0) {
        this.supportMessages = [...this.supportMessages, ...newMsgs];
        this.supportLastMsgTime = newMsgs[newMsgs.length - 1].created_at;
        const fromAdmin = isBaseline ? 0 : newMsgs.filter(m => m.sender_role === 'admin').length;
        // Оператор ответил — снимаем накопленный антиспам-штраф
        if (newMsgs.some(m => m.sender_role === 'admin')) this.resetSpamGuard();
        if (viewing) {
          this.renderSupportMessages();
        }
        if (fromAdmin > 0 && !viewing) {
          this.supportUnread += fromAdmin;
          this.updateSupportBadge();
          if (!this.isOpen) showToast('Поддержка ответила на ваше обращение', 'success');
        }
      }

      if (res.status !== 'closed') return;

      this.stopSupportPolling();
      this.supportChatId = null;
      localStorage.removeItem('sd_sup_chat_id');
      localStorage.removeItem('sd_sup_reason');
      const supView = this.panel?.querySelector<HTMLElement>('#sd-ap-sup-view');
      if (supView && this.supportMode === 'support') {
        supView.innerHTML = `<div class="sd-sup-closed-msg">
          <div style="font-size:2rem">✅</div>
          <div>Диалог завершён оператором</div>
          <button class="sd-sup-reason-btn" id="sd-sup-new-chat">Написать снова</button>
        </div>`;
        supView.querySelector('#sd-sup-new-chat')?.addEventListener('click', () => {
          this.supportMessages = [];
          this.supportLastMsgTime = null;
          this.renderSupportReasonSelect(supView);
        });
      } else {
        this.supportMessages = [];
        this.supportLastMsgTime = null;
      }
      // 2 с: отметка набора живёт 6 с, при более редком опросе индикатор мигает
    }, 2000);
  }

  private stopSupportPolling(): void {
    if (this.supportPollTimer) { clearInterval(this.supportPollTimer); this.supportPollTimer = null; }
    this.supportPeerTyping = false;
  }

  private executeSupportAction(name: string): void {
    const root = document.documentElement;
    switch (name) {
      case 'toggle_theme_off':
        root.setAttribute('data-theme', 'dark');
        localStorage.setItem('sd_theme', 'dark');
        showToast('Переключено на тёмную тему', 'success');
        break;
      case 'toggle_theme_on':
        root.setAttribute('data-theme', 'light');
        localStorage.setItem('sd_theme', 'light');
        showToast('Переключено на светлую тему', 'success');
        break;
      case 'reload_page':
        location.reload();
        break;
      default:
        showToast('Действие не поддерживается', 'warning');
    }
  }

  closePanel(): void {
    if (!this.panel) return;
    this.isOpen = false;
    this.btn?.classList.remove('active');
    this.stopMsgTts();
    this.stopVoice();

    const panel = this.panel;
    this.lastPos = '';   // при следующем открытии пересчитать положение заново

    const finish = () => panel.classList.remove('open', 'sidebar', 'closing', 'sd-ap-resizing');

    panel.classList.add('closing');
    panel.addEventListener('animationend', finish, { once: true });
    // Подстраховка, если animationend не сработает
    setTimeout(() => { if (panel.classList.contains('closing')) finish(); }, 300);
  }

  private addUserMessage(text: string, files: AttachedFile[] = []): void {
    if (!this.messagesEl) return;
    const el = document.createElement('div');
    el.className = 'sd-ap-msg user';
    const safe = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const filesHtml = files.map(f => {
      if (f.kind === 'image' && f.imageDataUrl) {
        return `<img class="sd-ap-msg-img" src="${f.imageDataUrl}" alt="${f.name}">`;
      }
      const icon = f.name.endsWith('.xlsx') || f.name.endsWith('.xls') ? '📊' : f.name.endsWith('.pdf') ? '📄' : '📝';
      return `<div class="sd-ap-msg-file">${icon} ${f.name.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`;
    }).join('');
    el.innerHTML = `
      <div class="sd-ap-msg-avatar">Я</div>
      <div class="sd-ap-msg-bubble">
        ${filesHtml}${safe}
        <div class="sd-ap-msg-footer">
          <button class="msg-copy-btn" title="Копировать">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
      </div>`;
    el.querySelector<HTMLElement>('.msg-copy-btn')?.addEventListener('click', (e) => {
      navigator.clipboard.writeText(text).catch(() => {});
      const btn = e.currentTarget as HTMLElement;
      btn.classList.add('copied');
      btn.title = 'Скопировано!';
      showToast('Скопировано', 'success');
      setTimeout(() => { btn.classList.remove('copied'); btn.title = 'Копировать'; }, 1500);
    });
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  private addAssistantMessage(text: string, navAction?: NavAction): HTMLElement | null {
    if (!this.messagesEl) return null;
    const navHtml = navAction
      ? `<div class="sd-ap-nav-card" data-page="${esc(navAction.page)}">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
           Перейти: ${esc(navAction.label ?? navAction.page)}
         </div>`
      : '';
    const el = document.createElement('div');
    el.className = 'sd-ap-msg assistant';
    el.innerHTML = `
      <div class="sd-ap-msg-avatar">С</div>
      <div class="sd-ap-msg-bubble">
        ${renderMarkdown(text)}${navHtml}
        <div class="sd-ap-msg-footer">
          <button class="msg-copy-btn" title="Копировать">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
          <button class="msg-tts-btn" title="Озвучить">
            <svg class="play-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <svg class="pause-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
            </svg>
          </button>
        </div>
      </div>`;

    el.querySelector<HTMLElement>('.sd-ap-nav-card')?.addEventListener('click', (ev) => {
      const page = (ev.currentTarget as HTMLElement).dataset.page;
      if (page) this.navigateTo(page);
    });

    const ttsBtn = el.querySelector<HTMLElement>('.msg-tts-btn')!;
    ttsBtn.addEventListener('click', () => {
      if (ttsBtn.classList.contains('speaking')) {
        this.stopMsgTts();
      } else {
        this.startMsgTts(text, ttsBtn);
      }
    });

    const copyBtn = el.querySelector<HTMLElement>('.msg-copy-btn');
    copyBtn?.addEventListener('click', (e) => {
      const plain = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#{1,3}\s+/gm, '').trim();
      navigator.clipboard.writeText(plain).catch(() => {});
      const btn = e.currentTarget as HTMLElement;
      btn.classList.add('copied');
      btn.title = 'Скопировано!';
      showToast('Скопировано', 'success');
      setTimeout(() => { btn.classList.remove('copied'); btn.title = 'Копировать'; }, 1500);
    });

    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return ttsBtn;
  }

  private addTypingIndicator(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'sd-ap-msg assistant sd-ap-typing-msg';
    el.innerHTML = `
      <div class="sd-ap-msg-avatar">С</div>
      <div class="sd-ap-typing"><span></span><span></span><span></span></div>`;
    this.messagesEl?.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  private removeTypingIndicator(el: HTMLElement): void {
    el.remove();
  }

  private scrollToBottom(): void {
    this.updateChatLayout();
    // Прокручивается обёртка, а не сама лента — у ленты своего скролла больше нет
    const scroller = this.panel?.querySelector<HTMLElement>('.sd-ap-scroll');
    if (scroller) {
      requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
    }
  }

  private updateChatLayout(): void {
    if (!this.panel) return;
    const hasMessages = this.messagesEl ? this.messagesEl.childElementCount > 0 : false;
    // When chatting, hide collapsible sections and hints to reduce clutter
    const hideWhenChatting = this.panel.querySelectorAll<HTMLElement>(
      '#sd-ap-quick-actions, #sd-ap-settings-section, .sd-ap-hints'
    );
    hideWhenChatting.forEach(el => {
      el.style.display = hasMessages ? 'none' : '';
    });
  }

  private setStatus(text: string, cls = ''): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.className = 'sd-ap-status' + (cls ? ` ${cls}` : '');
  }

  private autoResizeTextarea(): void {
    if (!this.textareaEl) return;
    this.textareaEl.style.height = 'auto';
    this.textareaEl.style.height = Math.min(this.textareaEl.scrollHeight, 100) + 'px';
  }

  // ── Send ─────────────────────────────────────────────────────────────────────

  private handleSend(): void {
    const text = this.textareaEl?.value.trim();
    if (!text || this.isLoading) return;
    // Unlock audio context from user gesture before async flow starts
    if (this.ttsEnabled) edgeTtsUnlock();
    if (this.textareaEl) { this.textareaEl.value = ''; this.textareaEl.style.height = 'auto'; }
    this.sendMessage(text);
  }

  async sendMessage(text: string): Promise<void> {
    if (!text.trim() || this.isLoading) return;
    ttsStop();

    // Build message content — include attachments if any
    const files = [...this.attachedFiles];
    this.attachedFiles = [];
    this.renderAttachChips();

    this.addUserMessage(text, files);
    // For history: always store as string (text + file descriptions)
    const fileCtx = files.length
      ? '\n\n' + files.map(f => f.kind === 'image'
          ? `[Изображение: ${f.name}]`
          : `[Файл: ${f.name}]\n${f.textContent ?? ''}`
        ).join('\n\n')
      : '';
    this.history.push({ role: 'user', content: text + fileCtx });

    // Fast client-side nav matching for common commands
    if (IS_NAV_COMMAND.test(text)) {
      const nav = tryLocalNav(text);
      if (nav) {
        this.addAssistantMessage(`Открываю «${nav.label}»…`, nav);
        this.history.push({ role: 'assistant', content: `Открываю «${nav.label}».` });
        setTimeout(() => this.navigateTo(nav.page), 300);
        return;
      }
    }

    // Fast undo path: "отмени/верни" — откатить последнее действие без LLM
    const UNDO_RE = /^(?:отмени|верни|отмена|вернуть|отменить|cancel|undo|сделай как было|верни как было|откати)/i;
    if (UNDO_RE.test(text.trim())) {
      this.isLoading = true;
      this.setInputEnabled(false);
      this.setStatus('Откатываю…', 'thinking');
      const typing = this.addTypingIndicator();
      try {
        const result = await changeLog.undoLast();
        this.removeTypingIndicator(typing);
        this.history.push({ role: 'assistant', content: result });
        const ttsBtn = this.addAssistantMessage(result);
        if (this.ttsEnabled && ttsBtn) this.startMsgTts(result, ttsBtn);
      } catch {
        this.removeTypingIndicator(typing);
        this.addAssistantMessage('Не удалось откатить последнее действие.');
      } finally {
        this.isLoading = false;
        this.setInputEnabled(true);
        this.setStatus('Готова');
      }
      return;
    }

    // Fast client-side task creation: "создай задачу [title]" — no LLM needed
    const createTaskRe = /^(?:создай|добавь|запиши|поставь)\s+задач[ую]\s+(.+)/i;
    const createMatch = text.trim().match(createTaskRe);
    if (createMatch) {
      const title = createMatch[1].trim();
      this.isLoading = true;
      this.setInputEnabled(false);
      await this.createTaskFromAI({ action: 'create_task', title });
      this.history.push({ role: 'assistant', content: `Задача создана: ${title}` });
      this.isLoading = false;
      this.setInputEnabled(true);
      return;
    }

    // Fast: mark task done — "отметь/выполни задачу X"
    const markDoneRe = /^(?:отметь|выполни|закрой|задача\s+выполнена?)\s+задач[ую]?\s+(.+)/i;
    const markDoneMatch = text.trim().match(markDoneRe);
    if (markDoneMatch && aiPage.hasAction('mark_task_done')) {
      const title = markDoneMatch[1].trim();
      this.isLoading = true;
      this.setInputEnabled(false);
      const typing = this.addTypingIndicator();
      try {
        const result = await aiPage.run('mark_task_done', { title });
        this.removeTypingIndicator(typing);
        this.history.push({ role: 'assistant', content: result.summary });
        const ttsBtn = this.addAssistantMessage(result.summary);
        if (this.ttsEnabled && ttsBtn) this.startMsgTts(result.summary, ttsBtn);
      } catch (e: unknown) {
        this.removeTypingIndicator(typing);
        this.addAssistantMessage(`Не удалось: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.isLoading = false;
        this.setInputEnabled(true);
      }
      return;
    }

    // Fast: unit economics calculator — "посчитай unit" / "юнит-экономика"
    const unitRe = /(?:посчитай|рассчитай|покажи|открой)\s+(?:unit|юнит)[- ]?эконом/i;
    if (unitRe.test(text.trim())) {
      this.addUnitEconomicsCard();
      return;
    }

    // LLM call
    if (!this.aiKey) {
      this.addAssistantMessage(
        'API-ключ OpenRouter не настроен. Попросите администратора добавить ключ в разделе «Настройки AI» в админ-панели SimaDesk.'
      );
      return;
    }

    this.isLoading = true;
    this.setStatus('Думаю…', 'thinking');
    const typing = this.addTypingIndicator();
    this.setInputEnabled(false);

    try {
      const storeCtx = getStoreContext();
      const pageFrag = aiPage.promptFragment();
      const selCtxFrag = selectionCtx.current.type !== 'none'
        ? '\n\n' + selectionCtx.current.prompt
        : '';
      const messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT + storeCtx + pageFrag + selCtxFrag },
        ...this.history.slice(-10),
      ];

      const images = files.filter(f => f.kind === 'image');
      const reply: string = await this.callAi(messages, images.length ? images : undefined);

      this.removeTypingIndicator(typing);
      this.history.push({ role: 'assistant', content: reply });

      // ── Page action / plan: управление текущей открытой страницей ─────────────
      // Модель иногда оборачивает JSON в ```json ... ``` — нормализуем перед парсингом.
      const replyNorm = reply.replace(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g, '$1');

      // Новый формат: plan — показываем карточку подтверждения
      const pageActPlan = this.parsePageActionPlan(replyNorm);
      if (pageActPlan) {
        const textPart = pageActPlan.raw ? replyNorm.split(pageActPlan.raw).join('').trim() : '';
        if (textPart) this.addAssistantMessage(textPart);
        this.addActionPlanCard(pageActPlan.name, pageActPlan.args, pageActPlan.plan, text);
        this.setStatus('Готова');
        return;
      }

      // Старый формат page_action — для совместимости (выполняем сразу)
      const pageAct = this.parsePageAction(replyNorm);
      if (pageAct) {
        const textPart = pageAct.raw ? replyNorm.split(pageAct.raw).join('').trim() : '';
        if (textPart) this.addAssistantMessage(textPart);
        await this.executePageAction(pageAct.name, pageAct.args, text);
        return;
      }

      // open_support action
      if (/"action"\s*:\s*"open_support"/.test(reply)) {
        this.addAssistantMessage('Конечно! Переключаю на поддержку SimaDesk — там ответит живой оператор.');
        setTimeout(() => this.switchSupportMode('support'), 600);
        this.setStatus('Готова');
        return;
      }

      // Parse nav action from LLM reply
      let navAction: NavAction | undefined;
      const jsonMatch = reply.match(/\{[^}]*"action"\s*:\s*"navigate"[^}]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as NavAction;
          if (parsed.action === 'navigate' && parsed.page) {
            navAction = parsed;
          }
        } catch { /* ignore */ }
      }

      if (navAction) {
        const label = navAction.label || navAction.page;
        this.addAssistantMessage(`Открываю «${label}»…`, navAction);
        setTimeout(() => this.navigateTo(navAction!.page), 400);
      } else {
        // Check for task actions
        const taskAction = this.parseTaskAction(reply);
        if (taskAction) {
          const displayText = reply.replace(/\{[\s\S]*?\}/g, '').trim();
          if (displayText) {
            this.addAssistantMessage(displayText);
          }
          await this.handleTaskAction(taskAction);
        } else {
          const { text: displayText, suggestions: followUps } = this.parseFollowUpSuggestions(reply);
          const ttsBtn = this.addAssistantMessage(displayText);
          if (this.ttsEnabled && ttsBtn) this.startMsgTts(displayText, ttsBtn);
          if (followUps.length) this.addFollowUpSuggestions(followUps);
        }
      }

      this.setStatus('Готова');
    } catch (err: unknown) {
      this.removeTypingIndicator(typing);
      const msg = (err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err))?.includes('401')
        ? 'Неверный API-ключ OpenRouter. Проверьте ключ в настройках AI.'
        : (err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err))?.includes('429')
        ? 'Превышен лимит запросов. Попробуйте через минуту.'
        : `Ошибка: ${(err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err)) ?? 'неизвестная ошибка'}`;
      this.addAssistantMessage(msg);
      this.setStatus('Ошибка');
    } finally {
      this.isLoading = false;
      this.setInputEnabled(true);
    }
  }

  /** Один запрос к OpenRouter, возвращает текст ответа модели. */
  private async callAi(
    messages: ChatMessage[],
    attachedImages?: AttachedFile[],
  ): Promise<string> {
    // If images attached, inject them into the last user message as multimodal content
    let apiMessages: any[] = messages;
    if (attachedImages?.length) {
      apiMessages = messages.map((m, i) => {
        if (i === messages.length - 1 && m.role === 'user') {
          const parts: any[] = [{ type: 'text', text: m.content }];
          for (const img of attachedImages) {
            if (img.imageDataUrl) parts.push({ type: 'image_url', image_url: { url: img.imageDataUrl } });
          }
          return { role: 'user', content: parts };
        }
        return m;
      });
    }

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.aiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'SimaDesk Assistant',
      },
      body: JSON.stringify({
        model: this.aiModel || 'anthropic/claude-haiku-4-5',
        messages: apiMessages,
        max_tokens: 1500,
        temperature: 0.7,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${errText}`);
    }
    const data = await res.json();
    reportAiUsage('Сима', data);
    return data?.choices?.[0]?.message?.content ?? '';
  }

  /** Извлечь из ответа действие страницы {"action":"page_action",...} (с вложенными args). */
  private parsePageAction(reply: string): { name: string; args: any; raw: string } | null {
    const found = this.extractBalancedJson(reply, '"page_action"');
    if (!found) return null;
    const p = found.value;
    if (p && p.action === 'page_action' && typeof p.name === 'string') {
      return { name: p.name, args: p.args ?? {}, raw: found.raw };
    }
    return null;
  }

  /** Извлечь план действия (требует подтверждения пользователя). */
  private parsePageActionPlan(reply: string): { name: string; args: any; plan: string; raw: string } | null {
    const found = this.extractBalancedJson(reply, '"page_action_plan"');
    if (!found) return null;
    const p = found.value;
    if (p && p.action === 'page_action_plan' && typeof p.name === 'string') {
      return { name: p.name, args: p.args ?? {}, plan: p.plan ?? '', raw: found.raw };
    }
    return null;
  }

  /** Показать карточку с планом действия и кнопками «Выполнить» / «Отмена». */
  private addActionPlanCard(
    name: string,
    args: any,
    plan: string,
    requestText: string,
  ): void {
    if (!this.messagesEl) return;
    const el = document.createElement('div');
    el.className = 'sd-ap-msg assistant';
    el.innerHTML = `
      <div class="sd-ap-msg-avatar">С</div>
      <div class="sd-ap-msg-bubble">
        <div class="sd-ap-plan-card">
          <div class="sd-ap-plan-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Готовлюсь выполнить
          </div>
          <div class="sd-ap-plan-body">${plan.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          <div class="sd-ap-plan-btns">
            <button class="sd-ap-plan-run">▶ Выполнить</button>
            <button class="sd-ap-plan-cancel">Отмена</button>
          </div>
        </div>
      </div>`;

    el.querySelector<HTMLElement>('.sd-ap-plan-run')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Выполняю…';
      (el.querySelector<HTMLButtonElement>('.sd-ap-plan-cancel'))!.disabled = true;
      await this.executePageAction(name, args, requestText, el);
    });

    el.querySelector<HTMLElement>('.sd-ap-plan-cancel')?.addEventListener('click', () => {
      el.remove();
      this.addAssistantMessage('Хорошо, действие отменено. Что-то ещё?');
    });

    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  /** Выполнить подтверждённое page_action: glow + run + log + follow-up. */
  private async executePageAction(
    name: string,
    args: any,
    requestText: string,
    planCardEl?: HTMLElement,
  ): Promise<void> {
    this.setStatus('Выполняю…', 'thinking');
    aiGlow(true);
    let resultMsg: string;
    try {
      const res = await aiPage.run(name, args);
      resultMsg = res.summary;
      changeLog.logAction({
        category: 'ai',
        action: ACTION_LABELS[name] ?? name,
        details: res.summary,
        requestText,
        undo: res.undo,
      });
    } catch (e: unknown) {
      resultMsg = `Не удалось выполнить: ${(e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e}`;
      changeLog.logAction({
        category: 'ai',
        action: ACTION_LABELS[name] ?? name,
        details: resultMsg,
        requestText,
      });
    } finally {
      setTimeout(() => aiGlow(false), 600);
    }

    planCardEl?.remove();

    let follow = '';
    try {
      follow = await this.callAi([
        { role: 'system', content: SYSTEM_PROMPT + getStoreContext() },
        ...this.history.slice(-8),
        { role: 'system', content: `[РЕЗУЛЬТАТ ДЕЙСТВИЯ ${name}]: ${resultMsg}\nНапиши пользователю короткое подтверждение результата по-русски — только обычный текст, без JSON, без кнопок, без планов.` },
      ]);
    } catch { follow = resultMsg; }
    follow = follow.replace(/\{[\s\S]*?"action"[\s\S]*?\}/g, '').trim() || resultMsg;

    this.history.push({ role: 'assistant', content: follow });
    const ttsBtn = this.addAssistantMessage(follow);
    if (this.ttsEnabled && ttsBtn) this.startMsgTts(follow, ttsBtn);
    this.setStatus('Готова');
  }

  /** Найти сбалансированный JSON-объект, содержащий подстроку mustInclude. */
  private extractBalancedJson(text: string, mustInclude: string): { value: any; raw: string } | null {
    const kIdx = text.indexOf(mustInclude);
    if (kIdx < 0) return null;
    let start = text.lastIndexOf('{', kIdx);
    while (start >= 0) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const raw = text.slice(start, i + 1);
            try { return { value: JSON.parse(raw), raw }; } catch { break; }
          }
        }
      }
      start = text.lastIndexOf('{', start - 1);
    }
    return null;
  }

  private parseFollowUpSuggestions(reply: string): { text: string; suggestions: string[] } {
    const match = reply.match(/\{"suggestions"\s*:\s*\[([^\]]*)\]\s*\}\s*$/s);
    if (!match) return { text: reply, suggestions: [] };
    try {
      const obj = JSON.parse(match[0]);
      if (Array.isArray(obj.suggestions)) {
        const text = reply.slice(0, match.index).trim();
        return { text: text || reply, suggestions: obj.suggestions.filter((s: any) => typeof s === 'string') };
      }
    } catch { /* ignore */ }
    return { text: reply, suggestions: [] };
  }

  private addFollowUpSuggestions(suggestions: string[]): void {
    if (!this.messagesEl || !suggestions.length) return;
    const el = document.createElement('div');
    el.className = 'sd-ap-followup';
    el.innerHTML = suggestions
      .map(s => `<button class="sd-ap-followup-btn">${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</button>`)
      .join('');
    el.querySelectorAll<HTMLButtonElement>('.sd-ap-followup-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        el.remove();
        this.sendMessage(btn.textContent || '');
      });
    });
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  private addUnitEconomicsCard(): void {
    if (!this.messagesEl) return;
    const el = document.createElement('div');
    el.className = 'sd-ap-msg assistant';
    el.innerHTML = `
      <div class="sd-ap-msg-avatar">С</div>
      <div class="sd-ap-msg-bubble sd-ap-unit-card">
        <div class="sd-ap-unit-title">Калькулятор unit-экономики</div>
        <div class="sd-ap-unit-grid">
          <label>Цена продажи (₽)<input class="sd-ap-unit-in" data-field="price" type="number" min="0" placeholder="1500"></label>
          <label>Себестоимость (₽)<input class="sd-ap-unit-in" data-field="cost" type="number" min="0" placeholder="400"></label>
          <label>Комиссия МП (%)<input class="sd-ap-unit-in" data-field="commission" type="number" min="0" max="50" placeholder="15"></label>
          <label>Логистика (₽)<input class="sd-ap-unit-in" data-field="logistics" type="number" min="0" placeholder="120"></label>
          <label>Реклама ДРР (%)<input class="sd-ap-unit-in" data-field="drr" type="number" min="0" max="100" placeholder="10"></label>
          <label>Хранение/ед (₽)<input class="sd-ap-unit-in" data-field="storage" type="number" min="0" placeholder="5"></label>
          <label>Возвраты (%)<input class="sd-ap-unit-in" data-field="returns" type="number" min="0" max="100" placeholder="12"></label>
          <label>Налог (%)<input class="sd-ap-unit-in" data-field="tax" type="number" min="0" max="50" placeholder="6"></label>
        </div>
        <div class="sd-ap-unit-result" id="sd-unit-result">Заполните поля выше</div>
      </div>`;
    const calc = () => {
      const v = (f: string) => parseFloat((el.querySelector(`[data-field="${f}"]`) as HTMLInputElement)?.value || '0') || 0;
      const price = v('price'), cost = v('cost'), commission = v('commission'),
            logistics = v('logistics'), drr = v('drr'), storage = v('storage'),
            returns = v('returns'), tax = v('tax');
      if (!price) { el.querySelector('#sd-unit-result')!.textContent = 'Заполните поля выше'; return; }
      const commAmt  = price * commission / 100;
      const drrAmt   = price * drr / 100;
      const taxAmt   = price * tax / 100;
      const retLoss  = price * returns / 100;
      const profit   = price - cost - commAmt - logistics - drrAmt - storage - retLoss - taxAmt;
      const margin   = price > 0 ? (profit / price * 100).toFixed(1) : '0';
      const roi      = cost > 0 ? (profit / cost * 100).toFixed(0) : '—';
      const color    = profit > 0 ? '#6ee7b7' : '#f87171';
      const res = el.querySelector<HTMLElement>('#sd-unit-result')!;
      res.innerHTML = `
        <span style="color:${color};font-size:15px;font-weight:700">${profit >= 0 ? '+' : ''}${Math.round(profit)} ₽</span>
        &nbsp;прибыль с единицы &nbsp;|&nbsp; маржа <b>${margin}%</b> &nbsp;|&nbsp; ROI <b>${roi}%</b>
        <div style="font-size:10px;margin-top:4px;opacity:.7">
          Комиссия ${Math.round(commAmt)}₽ · Лог ${logistics}₽ · Реклама ${Math.round(drrAmt)}₽ · Возвраты ${Math.round(retLoss)}₽ · Налог ${Math.round(taxAmt)}₽
        </div>`;
    };
    el.querySelectorAll('.sd-ap-unit-in').forEach(inp => inp.addEventListener('input', calc));
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  private setInputEnabled(enabled: boolean): void {
    const send = this.panel?.querySelector<HTMLButtonElement>('.sd-ap-send-btn');
    const mic  = this.panel?.querySelector<HTMLButtonElement>('.sd-ap-mic-btn');
    if (this.textareaEl) this.textareaEl.disabled = !enabled;
    if (send) send.disabled = !enabled;
    if (mic)  mic.disabled  = !enabled;
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

  private navigateTo(page: string): void {
    if ((window as any).app?.navigateTo) {
      (window as any).app.navigateTo(page);
      this.closePanel();
    }
  }

  // ── Voice input ───────────────────────────────────────────────────────────────


  private startVoice(): void {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      showToast('Голосовой ввод не поддерживается в этом браузере', 'error');
      return;
    }

    const rec = new SR();
    rec.lang = 'ru-RU';
    rec.continuous = false;
    rec.interimResults = true;
    this.recognition = rec;
    this.isListening = true;

    // Запоминаем что уже есть в поле — чтобы дописывать, а не перезаписывать
    this.voicePrefix = this.textareaEl?.value.trim() ?? '';

    const micBtn = this.panel?.querySelector<HTMLElement>('.sd-ap-mic-btn');
    if (micBtn) micBtn.classList.add('listening');
    this.btn?.classList.add('listening');
    this.setStatus('Слушаю…', 'listening');

    rec.onresult = (e: any) => {
      const results = Array.from(e.results) as any[];
      const transcript = results.map(r => r[0]?.transcript ?? '').join('');
      // Дописываем к уже существующему тексту
      const combined = this.voicePrefix ? this.voicePrefix + ' ' + transcript : transcript;
      if (this.textareaEl) {
        this.textareaEl.value = combined;
        this.autoResizeTextarea();
      }
      const lastResult = results[results.length - 1];
      if (lastResult?.isFinal) {
        const shouldSend = this.voiceSendOnEnd && !!combined.trim();
        this.stopVoice(); // resets voiceSendOnEnd — check after capturing above
        if (shouldSend) {
          setTimeout(() => this.handleSend(), 80);
        } else {
          this.textareaEl?.focus();
        }
      }
    };

    rec.onerror = () => {
      this.stopVoice();
      this.setStatus('Готова');
    };

    rec.onend = () => {
      this.isListening = false;
      const micBtn = this.panel?.querySelector<HTMLElement>('.sd-ap-mic-btn');
      if (micBtn) micBtn.classList.remove('listening');
      this.btn?.classList.remove('listening');
      if (!this.isLoading) this.setStatus('Готова');
    };

    try {
      rec.start();
    } catch {
      this.stopVoice();
    }
  }

  private stopVoice(): void {
    if (this.recognition) {
      try { this.recognition.stop(); } catch { /* ignore */ }
      this.recognition = null;
    }
    this.isListening = false;
    this.voiceSendOnEnd = false;
    this.voiceHotkeyHeld = false;
    const micBtn = this.panel?.querySelector<HTMLElement>('.sd-ap-mic-btn');
    if (micBtn) micBtn.classList.remove('listening');
    this.btn?.classList.remove('listening');
  }
}

export const assistantModule = new AssistantModule();
