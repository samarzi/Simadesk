/**
 * aiPageCapabilities — единое место, где для каждого раздела SimaDesk собирается
 * его «капабилити» для ассистента: структура (describe), кнопки-подсказки и,
 * где уместно, действия управления. Данные берутся из уже существующих
 * window.*Module (тот же приём, что в getStoreContext ассистента), поэтому
 * не нужно править каждый модуль по отдельности.
 *
 * setActiveAiPage(page) вызывается из навигации при каждом переходе.
 * installGlobalAiActions() регистрирует кросс-страничные действия (один раз).
 */

import { aiPage, type AiPageCapability, type AiSuggestion, type AiAction } from './aiPageContext';
import { registerUndoHandler } from '@/modules/LogsModule';

const w = () => window as any;
const fmtRub = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} млн ₽`
  : n >= 1_000 ? `${(n / 1_000).toFixed(0)} тыс ₽`
  : `${Math.round(n)} ₽`;

const PAGE_TITLE: Record<string, string> = {
  home: 'Обзор', analytics: 'Аналитика', repricer: 'Репрайсер', orders: 'Заказы',
  'products-hub': 'Товары', stock: 'Остатки', producers: 'Производители', tasks: 'Задачи',
  simastore: 'Витрина', marketplaces: 'Маркетплейсы', ozon: 'Ozon', wb: 'Wildberries',
  yandex: 'Яндекс Маркет', settings: 'Настройки', profile: 'Профиль', reviews: 'Отзывы',
  chats: 'Чаты', docs: 'Редактор', 'sku-audit': 'Анализ SKU', 'orders-ozon': 'Заказы Ozon',
  'orders-wb': 'Заказы WB', 'orders-yandex': 'Заказы ЯМ', producers2: '',
};

// ── describe() по разделам ─────────────────────────────────────────────────────

function describeAnalytics(): string {
  const am = w().analyticsModule;
  const kpi = am?.kpi;
  if (!kpi) return 'Раздел аналитики. Данные ещё не загружены — попроси открыть/обновить.';
  return `Аналитика (текущий период):
Выручка нетто: ${fmtRub(kpi.revenue)} | Валовая: ${fmtRub(kpi.revenue_gross ?? 0)}
Заказов: ${(kpi.orders_delivered ?? 0) + (kpi.orders_processing ?? 0)} | Возвраты: ${kpi.orders_returned ?? 0} | Отмены: ${kpi.orders_cancelled ?? 0}
Маржа: ${kpi.margin_pct?.toFixed?.(1) ?? '—'}% | Ср. чек: ${fmtRub(kpi.avg_check ?? 0)}
Комиссии МП: ${fmtRub(kpi.commission ?? 0)} | Логистика: ${fmtRub(kpi.logistics ?? 0)}`;
}

function pickOrderFields(o: any): string {
  const article = o.article ?? o.offer_id ?? o.sku ?? o.vendor_code ?? o.nm_id ?? o.market_sku ?? '—';
  const status = o.status ?? o.state ?? '—';
  const date = o.created_at ?? o.date ?? o.createdAt ?? o.in_process_at ?? o.purchase_date ?? '';
  const price = o.price ?? o.amount ?? o.total ?? o.sum ?? '';
  const mp = o.mp ?? o.marketplace ?? '';
  return `${date ? new Date(date).toLocaleDateString('ru-RU') + ' ' : ''}${mp ? '[' + mp + '] ' : ''}арт ${article} · ${status}${price ? ' · ' + price + '₽' : ''}`;
}

function describeOrders(): string {
  const om = w().allOrdersModule;
  const orders: any[] = om?.orders ?? [];
  if (!orders.length) return 'Раздел заказов. Список пуст или ещё не загружен.';
  const byStatus: Record<string, number> = {};
  const byMp: Record<string, number> = {};
  orders.forEach(o => {
    const s = o.status ?? o.state ?? 'unknown'; byStatus[s] = (byStatus[s] || 0) + 1;
    const m = o.mp ?? o.marketplace ?? '—'; byMp[m] = (byMp[m] || 0) + 1;
  });
  const sample = orders.slice(0, 20).map((o, i) => `  ${i + 1}. ${pickOrderFields(o)}`).join('\n');
  return `Заказы: всего ${orders.length}.
По статусам: ${Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join(' | ')}
По маркетплейсам: ${Object.entries(byMp).map(([m, n]) => `${m}: ${n}`).join(' | ')}
Последние заказы (до 20; отвечай на вопросы вроде «сколько вчера» и «какие артикулы» по этим данным):
${sample}`;
}

function describeStock(): string {
  const sm = w().stockModule;
  const items: any[] = sm?.items ?? [];
  if (!items.length) return 'Раздел остатков. Данные ещё не загружены.';
  const oos = items.filter(i => (i.stockTotal ?? 0) === 0);
  const low = items.filter(i => (i.stockTotal ?? 0) > 0 && (i.stockTotal ?? 0) < 10);
  return `Остатки: всего SKU ${items.length} | норма ${items.length - oos.length - low.length} | мало (<10) ${low.length} | OOS ${oos.length}
${oos.length ? 'Нет в наличии: ' + oos.slice(0, 8).map(i => `"${i.name || i.offerId}"(${i.mp ?? ''})`).join(', ') : ''}
${low.length ? 'Заканчивается: ' + low.slice(0, 6).map(i => `"${i.name || i.offerId}" ${i.stockTotal}шт`).join(', ') : ''}`;
}

function describeTasks(): string {
  const tm = w().taskManagerModule;
  const tasks: any[] = tm?.tasks ?? [];
  if (!tasks.length) return 'Раздел задач. Задач пока нет.';
  const open = tasks.filter(t => t.status !== 'done');
  const overdue = open.filter(t => t.due_date && new Date(t.due_date) < new Date());
  return `Задачи: открытых ${open.length}, просрочено ${overdue.length}.
${overdue.length ? 'Просроченные: ' + overdue.slice(0, 5).map(t => `"${t.title}"`).join(', ') : ''}
${open.length ? 'Открытые: ' + open.slice(0, 6).map(t => `"${t.title}"`).join(', ') : ''}`;
}

function describeProducts(): string {
  const pm = w().productsHubModule;
  const items: any[] = pm?.items ?? [];
  if (!items.length) return 'Раздел товаров. Каталог ещё не загружен.';
  const selected: string = pm?.getAiSelectedContext?.() ?? '';
  const selCount: number = pm?.selectedArticles?.size ?? 0;
  let out = `Раздел «Товары»: всего ${items.length} артикулов.`;
  if (selCount > 0 && selected) {
    out += `\n\nВЫДЕЛЕНО ${selCount} ТОВАРОВ:\n${selected}`;
    out += `\n\nТы видишь выделенные товары. Пользователь может просить сравнить, найти дешевле, изменить цены.`;
  } else {
    out += ` Можно спрашивать про артикулы, цены, остатки, маркетплейсы. Если нужно работать с конкретными товарами — попроси пользователя выделить их в списке.`;
  }
  return out;
}

function describeReviews(): string {
  const rm = w().reviewsModule;
  const reviews: any[] = rm?.reviews ?? rm?.items ?? [];
  if (!reviews.length) return 'Раздел отзывов. Отзывы ещё не загружены.';
  const unanswered = reviews.filter(r => !r.answered && !r.answer);
  return `Отзывы: всего ${reviews.length}, без ответа ~${unanswered.length}. Негатив стоит отрабатывать в течение 12 часов.`;
}

function describeGeneric(page: string): string {
  const title = PAGE_TITLE[page] ?? page;
  return `Открыт раздел «${title}». Можешь помочь пользователю разобраться с ним, подсказать действия и, если попросят, перейти в другой раздел.`;
}

// ── Кнопки-подсказки по разделам ────────────────────────────────────────────────

const SUGGESTIONS: Record<string, AiSuggestion[]> = {
  home: [
    { label: '📊 Что важного сегодня?', prompt: 'Сделай сводку: что важного по магазину сегодня и на что обратить внимание' },
    { label: '⚠️ Найди риски', prompt: 'Проанализируй данные и найди риски (остатки, заказы, цены)' },
    { label: '➕ Новый Excel', prompt: 'Создай новый документ Excel' },
  ],
  analytics: [
    { label: '📈 Разбор за 30 дней', prompt: 'Проанализируй аналитику за 30 дней: выручка, маржа, тренды' },
    { label: '🏆 Топ и аутсайдеры', prompt: 'Покажи топ товаров и аутсайдеров по выручке' },
    { label: '🧮 Unit-экономика', prompt: 'Оцени unit-экономику по текущим данным' },
  ],
  orders: [
    { label: '📦 Сколько заказов вчера', prompt: 'Сколько было заказов вчера и какие артикулы?' },
    { label: '⏰ Проблемные заказы', prompt: 'Есть ли заказы с риском просрочки отгрузки?' },
    { label: '📊 Разбивка по МП', prompt: 'Покажи разбивку заказов по маркетплейсам' },
  ],
  stock: [
    { label: '🚫 Что в OOS', prompt: 'Какие товары закончились (OOS) и что срочно пополнить?' },
    { label: '📉 Заканчивается', prompt: 'Какие товары скоро закончатся?' },
  ],
  tasks: [
    { label: '📋 Что просрочено', prompt: 'Какие задачи просрочены?' },
    { label: '➕ Создать задачу', prompt: 'Создай задачу ' },
  ],
  'products-hub': [
    { label: '💰 Сравни цены', prompt: 'Сравни цены выделенных товаров по маркетплейсам, где дешевле?' },
    { label: '✏️ Изменить цену', prompt: 'Измени цену ' },
    { label: '📊 Анализ остатков', prompt: 'Какие из выделенных товаров заканчиваются по остаткам?' },
    { label: '🔍 Найти товар', prompt: 'Найди товар по артикулу ' },
  ],
  reviews: [
    { label: '💬 Без ответа', prompt: 'Какие отзывы без ответа и на что ответить в первую очередь?' },
  ],
  repricer: [
    { label: '💸 Как работает репрайсер', prompt: 'Объясни как настроить репрайсер и стратегии цен' },
  ],
  docs: [
    { label: '➕ Новый Excel', prompt: 'Создай новый документ Excel' },
    { label: '✨ Улучшить дизайн', prompt: 'Улучши дизайн текущей таблицы' },
    { label: '🔎 Что в таблице?', prompt: 'Проанализируй открытую таблицу: что за данные, какие колонки' },
  ],
};

const GENERIC_SUGGESTIONS: AiSuggestion[] = [
  { label: '❓ Как этим пользоваться', prompt: 'Расскажи как пользоваться этим разделом' },
  { label: '➕ Новый Excel', prompt: 'Создай новый документ Excel' },
];

// ── Сборка капабилити для страницы ───────────────────────────────────────────────

const DESCRIBERS: Record<string, () => string> = {
  analytics: describeAnalytics,
  orders: describeOrders,
  'orders-ozon': describeOrders,
  'orders-wb': describeOrders,
  'orders-yandex': describeOrders,
  stock: describeStock,
  tasks: describeTasks,
  'products-hub': describeProducts,
  reviews: describeReviews,
};

// ── Actions: задачи ──────────────────────────────────────────────────────────────

const TASKS_ACTIONS: AiAction[] = [
  {
    name: 'mark_task_done',
    description: 'Отметить задачу как выполненную по названию. Используй когда говорят «выполнена задача X», «отметь задачу X готовой», «закрой задачу». Ищет по вхождению названия.',
    args: '{ title: string }',
    run: async (a: { title: string }) => {
      const tm = w().taskManagerModule;
      const tasks: any[] = tm?.tasks ?? [];
      const needle = (a.title || '').toLowerCase().trim();
      const task = tasks.find(t => t.status !== 'done' && t.title.toLowerCase().includes(needle));
      if (!task) throw new Error(`Задача «${a.title}» не найдена среди открытых`);
      const { taskDb } = await import('@/services/taskDb');
      await taskDb.updateTask(task.id, { status: 'done' });
      tm?.load?.();
      return {
        summary: `Задача «${task.title}» отмечена выполненной`,
        undo: { kind: 'task_status', payload: { id: task.id, status: task.status }, label: `Задача: ${task.title}` },
      };
    },
  },
];

// ── Actions: отзывы ──────────────────────────────────────────────────────────────

const REVIEWS_ACTIONS: AiAction[] = [
  {
    name: 'reply_review',
    description: 'Опубликовать ответ на отзыв покупателя. Используй когда просят «ответь на этот отзыв», «напиши ответ». Если review_id не передан — отвечает на первый отзыв без ответа. text — готовый текст ответа.',
    args: '{ text: string, review_id?: string }',
    run: async (a: { text: string; review_id?: string }) => {
      const rm = w().reviewsModule;
      if (!rm) throw new Error('Модуль отзывов недоступен на этой странице');
      if (typeof rm.aiReplyReview === 'function') {
        const res = await rm.aiReplyReview(a.review_id ?? null, a.text);
        return typeof res === 'string' ? res : 'Ответ опубликован';
      }
      // Fallback: ищем отзыв и обновляем через API напрямую
      const reviews: any[] = rm.reviews ?? rm.items ?? [];
      const review = a.review_id
        ? reviews.find(r => String(r.id) === String(a.review_id))
        : reviews.find(r => !r.answered && !r.answer && !r.reply);
      if (!review) throw new Error('Отзыв без ответа не найден. Возможно, все отзывы уже обработаны');
      if (!review.id) throw new Error('ID отзыва неизвестен — ответьте вручную');
      const { dbFetch } = await import('@/services/dbClient');
      await dbFetch(`/rest/v1/reviews?id=eq.${review.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ answer: a.text, answered: true }),
      });
      rm.load?.();
      return `Ответ на отзыв (${review.stars ?? '?'}★) опубликован`;
    },
  },
];

// ── Actions: репрайсер ────────────────────────────────────────────────────────────

const REPRICER_ACTIONS: AiAction[] = [
  {
    name: 'create_repricer_rule',
    description: 'Создать правило репрайсера. Используй когда просят «создай правило», «настрой автоцену», «поставь мин. цену X для артикула Y». Если модуль поддерживает — создаёт правило; иначе — навигирует в раздел с инструкцией.',
    args: '{ name: string, mp: "wb"|"ozon"|"yandex", min_price?: number, max_price?: number, strategy?: "match"|"undercut", article?: string }',
    run: async (a: any) => {
      const rep = w().repricerModule;
      if (typeof rep?.aiCreateRule === 'function') return await rep.aiCreateRule(a);
      w().app?.navigateTo?.('repricer');
      const parts = [
        a.name ? `Название: «${a.name}»` : '',
        a.mp ? `Маркетплейс: ${a.mp.toUpperCase()}` : '',
        a.min_price ? `Мин. цена: ${a.min_price} ₽` : '',
        a.max_price ? `Макс. цена: ${a.max_price} ₽` : '',
        a.strategy === 'undercut' ? 'Стратегия: чуть дешевле конкурента' : a.strategy === 'match' ? 'Стратегия: по цене конкурента' : '',
      ].filter(Boolean).join(', ');
      return `Открываю Репрайсер. Создайте правило вручную: ${parts || 'параметры не указаны'}.`;
    },
  },
];

// ── Actions: остатки ──────────────────────────────────────────────────────────────

const STOCK_ACTIONS: AiAction[] = [
  {
    name: 'set_stock_alert',
    description: 'Установить порог алерта по остаткам. Используй когда говорят «предупреди если меньше X», «алерт на 5 единиц», «уведомляй при остатке ниже 10». Без article — глобальный порог для всего каталога.',
    args: '{ threshold: number, article?: string }',
    run: (a: { threshold: number; article?: string }) => {
      const sm = w().stockModule;
      if (typeof sm?.aiSetAlert === 'function') return sm.aiSetAlert(a.threshold, a.article);
      const key = a.article ? `sd_stock_alert_${a.article}` : 'sd_stock_alert_global';
      localStorage.setItem(key, String(a.threshold));
      return a.article
        ? `Алерт установлен: остаток «${a.article}» ниже ${a.threshold} ед. — буду предупреждать`
        : `Глобальный алерт: предупреждать при остатке любого товара ниже ${a.threshold} ед.`;
    },
  },
];

// ── Actions: товары ──────────────────────────────────────────────────────────────

const PRODUCTS_HUB_ACTIONS: AiAction[] = [
  {
    name: 'set_price',
    description: 'Установить конкретную цену для товара на маркетплейсе. Используй когда пользователь говорит «поставь цену X», «измени цену на Y», «цена артикула Z на Яндексе — 7000₽». Если не указан магазин (store) и их несколько — действие бросит ошибку с перечнем магазинов, тогда уточни у пользователя.',
    args: '{ article: string, mp: "wb"|"ozon"|"yandex", price: number, store?: string }',
    run: (a) => {
      const pm = w().productsHubModule;
      if (!pm?.aiSetPrice) throw new Error('Модуль товаров недоступен');
      return pm.aiSetPrice(a);
    },
  },
  {
    name: 'apply_price_delta',
    description: 'Изменить цены выделенных (или указанных) товаров на маркетплейсе — прибавить/вычесть сумму или процент. Используй когда говорят «подними цены на 500р», «скидка 10%», «снизь цену для выделенных на ВБ». Если articles не передан — применяется ко всем выделенным товарам.',
    args: '{ mp: "wb"|"ozon"|"yandex", delta: number, percent?: boolean, articles?: string[] }',
    run: (a) => {
      const pm = w().productsHubModule;
      if (!pm?.aiApplyPriceDelta) throw new Error('Модуль товаров недоступен');
      return pm.aiApplyPriceDelta(a);
    },
  },
];

export function capabilityForPage(page: string): AiPageCapability | null {
  // Редактор ведёт себя богаче — берём капабилити прямо у модуля.
  if (page === 'docs') {
    const dm = w().docsModule;
    if (dm?.getAiCapability) return dm.getAiCapability();
  }

  const title = PAGE_TITLE[page];
  if (!title) return null; // неизвестная страница — без капабилити

  const describe = DESCRIBERS[page] ?? (() => describeGeneric(page));
  const suggestions = SUGGESTIONS[page] ?? GENERIC_SUGGESTIONS;
  const PAGE_ACTIONS: Record<string, AiAction[]> = {
    'products-hub': PRODUCTS_HUB_ACTIONS,
    'tasks': TASKS_ACTIONS,
    'reviews': REVIEWS_ACTIONS,
    'repricer': REPRICER_ACTIONS,
    'stock': STOCK_ACTIONS,
  };
  const actions = PAGE_ACTIONS[page] ?? [];

  return { page, title, describe, actions, suggestions };
}

/** Установить активную AI-страницу (вызывается из навигации). */
export function setActiveAiPage(page: string): void {
  const cap = capabilityForPage(page);
  if (cap) aiPage.register(cap);
  else aiPage.clear();
}

// ── Глобальные (кросс-страничные) действия ──────────────────────────────────────

function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  return new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      if (cond() || Date.now() - t0 > ms) resolve();
      else setTimeout(tick, 60);
    };
    tick();
  });
}

let installed = false;
export function installGlobalAiActions(): void {
  if (installed) return;
  installed = true;

  // Обработчик отката для действий редактора (восстановление снимка документа).
  registerUndoHandler('docs', (p: { docId: string; before: string }) => {
    w().docsModule?.aiUndoRestore?.(p);
  });
  registerUndoHandler('docs_multi', (p: { snapshots: Array<{ docId: string; before: string }> }) => {
    w().docsModule?.aiUndoRestoreMulti?.(p);
  });

  const createDoc: AiAction = {
    name: 'create_doc',
    description: 'Создать новый документ в Редакторе (Excel или Word). Работает из любого раздела — сам откроет Редактор.',
    args: '{ type: "excel"|"word", title?: string }',
    run: async (a: { type?: string; title?: string }) => {
      const type = a?.type === 'word' ? 'word' : 'excel';
      w().app?.navigateTo?.('docs');
      await waitFor(() => !!w().docsModule?.aiCreateDoc);
      const dm = w().docsModule;
      if (!dm?.aiCreateDoc) throw new Error('Редактор недоступен');
      return dm.aiCreateDoc(type, a?.title);
    },
  };
  aiPage.registerGlobal(createDoc);
}
