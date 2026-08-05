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
  supply: 'Поставки', advertising: 'Реклама',
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

function describeSupply(): string {
  const sm = w().supplyModule;
  if (!sm) return 'Раздел Поставок. Управляет поставками Ozon FBO, Wildberries FBO и Яндекс FBY.';
  const stats = sm.supplyStats ?? { draft: 0, sending: 0, delivered: 0, cancelled: 0 };
  const supplies: any[] = sm.supplies ?? [];
  const tab: string = sm.tab ?? 'ozon';
  const tabLabel = tab === 'ozon' ? 'Ozon FBO' : tab === 'wb' ? 'Wildberries' : 'Яндекс FBY';
  const total = stats.draft + stats.sending + stats.delivered + stats.cancelled;
  let out = `Раздел Поставок. Активная вкладка: ${tabLabel}.`;
  if (total) {
    out += `\nПоставок загружено: ${total} (черновик: ${stats.draft}, в пути: ${stats.sending}, принято: ${stats.delivered}, отменено: ${stats.cancelled}).`;
  } else {
    out += '\nДанные ещё не загружены или поставок нет.';
  }
  out += `\n\nВозможности:
- Ozon FBO: создать поставку, добавить товары по SKU, отправить, скачать штрихкоды, отменить, посмотреть состав.
- Wildberries: создать поставку вручную или из новых заказов (wizard), добавить FBO-заказы, скачать QR-код.
- Яндекс FBY: создать отгрузку с выбором окна приёмки, подтвердить отгрузку, скачать этикетки.
- Сима может: показать доступные слоты ЯМ, создать отгрузку ЯМ на дату, создать WB-поставку из заказов.`;
  if (supplies.length) {
    out += `\n\nПоследние поставки:\n${supplies.slice(0, 5).map(s => `  • ${s.name} [${s.status}] (${s.itemsCount} товаров)`).join('\n')}`;
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

// дополнительные разделы подсказок
Object.assign(SUGGESTIONS, {
  marketplaces: [
    { label: '🔄 Синхронизировать все МП', prompt: 'Синхронизируй данные со всех подключённых маркетплейсов' },
    { label: '🔑 Как подключить WB', prompt: 'Как получить и вставить API-ключ Wildberries?' },
    { label: '🔑 Как подключить Ozon', prompt: 'Как получить и вставить API-ключ Ozon?' },
  ],
  ozon: [
    { label: '📦 Заказы Ozon', prompt: 'Покажи статус заказов на Ozon' },
    { label: '📊 Аналитика Ozon', prompt: 'Дай аналитику по продажам на Ozon за последние 30 дней' },
    { label: '🔄 Обновить данные', prompt: 'Обнови данные синхронизации с Ozon' },
  ],
  wb: [
    { label: '📦 Заказы WB', prompt: 'Покажи статус заказов на Wildberries' },
    { label: '📊 Аналитика WB', prompt: 'Дай аналитику по продажам на Wildberries за последние 30 дней' },
    { label: '⭐ Штрафные баллы', prompt: 'Как проверить и снизить штрафные баллы на WB?' },
  ],
  yandex: [
    { label: '📦 Заказы ЯМ', prompt: 'Покажи статус заказов на Яндекс Маркет' },
    { label: '📊 Аналитика ЯМ', prompt: 'Дай аналитику по продажам на Яндекс Маркет' },
    { label: '🔄 Обновить данные', prompt: 'Обнови данные синхронизации с Яндекс Маркет' },
  ],
  settings: [
    { label: '🌙 Тёмная тема', prompt: 'Переключи на тёмную тему' },
    { label: '☀️ Светлая тема', prompt: 'Переключи на светлую тему' },
    { label: '🔑 Настроить AI', prompt: 'Как настроить API-ключ для Симы?' },
    { label: '👥 Добавить сотрудника', prompt: 'Как добавить нового сотрудника в команду?' },
  ],
  profile: [
    { label: '🔒 Сменить пароль', prompt: 'Как сменить пароль?' },
    { label: '📸 Фото профиля', prompt: 'Как изменить фото профиля?' },
  ],
  simastore: [
    { label: '🛒 Как настроить витрину', prompt: 'Расскажи как настроить и запустить собственную витрину SimaStore' },
    { label: '🔗 Получить ссылку', prompt: 'Как получить ссылку на мою витрину?' },
    { label: '📦 Товары на витрине', prompt: 'Как добавить товары на витрину из Products Hub?' },
  ],
  producers: [
    { label: '➕ Добавить поставщика', prompt: 'Как добавить нового поставщика/производителя?' },
    { label: '📋 Список поставщиков', prompt: 'Покажи список всех поставщиков и их условия' },
    { label: '📦 Планирование поставки', prompt: 'Помоги спланировать поставку с учётом текущих остатков' },
  ],
  supply: [
    { label: '📅 Слоты ЯМ на неделю', prompt: 'Какие даты доступны для отгрузки на Яндекс Маркет на ближайшие 7 дней?' },
    { label: '🚚 Создать отгрузку ЯМ', prompt: 'Создай отгрузку на Яндекс Маркет на ближайший рабочий день' },
    { label: '📦 WB из заказов', prompt: 'Создай поставку Wildberries из новых заказов' },
    { label: '📊 Статус поставок', prompt: 'Сколько поставок в каком статусе сейчас?' },
  ],
  advertising: [
    { label: '📊 Сводка по кампаниям', prompt: 'Дай сводку по рекламным кампаниям: CTR, ROI, бюджет' },
    { label: '💸 Где лучший ROI', prompt: 'Какая кампания показывает лучший ROI?' },
    { label: '⏸ Пауза убыточных', prompt: 'Какие кампании убыточны и их стоит остановить?' },
  ],
});

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
  supply: describeSupply,
};

// ── Actions: главная / дашборд ────────────────────────────────────────────────

const HOME_ACTIONS: AiAction[] = [
  {
    name: 'navigate_to_section',
    description: 'Перейти в любой раздел SimaDesk. Используй когда пользователь хочет открыть конкретный раздел.',
    args: '{ page: "home"|"analytics"|"repricer"|"orders"|"products-hub"|"stock"|"producers"|"tasks"|"simastore"|"marketplaces"|"ozon"|"wb"|"yandex"|"settings"|"profile"|"reviews"|"chats"|"docs"|"billing" }',
    run: async (a: { page: string }) => {
      w().app?.navigateTo?.(a.page);
      return `Перехожу в раздел «${a.page}»`;
    },
  },
  {
    name: 'create_daily_brief',
    description: 'Создать задачи по результатам утреннего анализа: OOS, просрочки, отзывы без ответа.',
    args: '{}',
    run: async () => {
      const { taskDb } = await import('@/services/taskDb');
      const created: string[] = [];

      // OOS задачи
      const stockItems: any[] = w().stockModule?.items ?? [];
      const oos = stockItems.filter((i: any) => (i.stockTotal ?? 0) === 0).slice(0, 5);
      for (const item of oos) {
        await taskDb.createTask({
          title: `OOS: пополнить «${String(item.name || item.offerId).slice(0, 50)}»`,
          description: `Товар закончился на складе (${item.mp ?? 'МП'}). Срочно заказать у поставщика.`,
          status: 'todo', priority: 'red', scheduled_date: null,
          due_date: null, due_time: null, end_time: null, all_day: true,
          tags: 'Сима,OOS', sort_order: 9999, parent_id: null, assignee_id: null,
        });
        created.push(`OOS: ${String(item.name || item.offerId).slice(0, 30)}`);
      }

      // Задачи по отзывам
      const reviews: any[] = w().reviewsModule?.reviews ?? [];
      const unanswered = reviews.filter((r: any) => !r.answered && !r.answer && (r.stars ?? 5) <= 2).slice(0, 3);
      if (unanswered.length > 0) {
        await taskDb.createTask({
          title: `Ответить на ${unanswered.length} негативных отзыва`,
          description: `Отзывы без ответа (1-2★): ${unanswered.map((r: any) => `"${String(r.text ?? '').slice(0, 30)}"`).join(', ')}`,
          status: 'todo', priority: 'yellow', scheduled_date: null,
          due_date: null, due_time: null, end_time: null, all_day: true,
          tags: 'Сима,Отзывы', sort_order: 9999, parent_id: null, assignee_id: null,
        });
        created.push(`Ответить на ${unanswered.length} отзыва`);
      }

      w().taskManagerModule?.load?.();

      if (!created.length) return 'Критичных проблем не обнаружено — задачи не созданы. Магазин работает штатно.';
      return `Создано ${created.length} задач:\n${created.map(t => `• ${t}`).join('\n')}`;
    },
  },
];

// ── Actions: маркетплейсы ─────────────────────────────────────────────────────

const MARKETPLACES_ACTIONS: AiAction[] = [
  {
    name: 'sync_marketplace',
    description: 'Запустить синхронизацию данных с маркетплейса. Используй когда говорят «обнови данные», «синхронизируй», «загрузи заказы». Если mp не указан — синхронизирует все.',
    args: '{ mp?: "wb"|"ozon"|"yandex" }',
    run: async (a: { mp?: string }) => {
      const app = w().app;
      const mps = a.mp ? [a.mp] : ['wb', 'ozon', 'yandex'];
      const synced: string[] = [];
      for (const mp of mps) {
        try {
          if (mp === 'wb' && w().wbModule?.syncOrders) {
            await w().wbModule.syncOrders();
            synced.push('Wildberries');
          } else if (mp === 'ozon' && w().ozonModule?.syncOrders) {
            await w().ozonModule.syncOrders();
            synced.push('Ozon');
          } else if (mp === 'yandex' && w().yandexModule?.syncOrders) {
            await w().yandexModule.syncOrders();
            synced.push('Яндекс Маркет');
          } else {
            app?.navigateTo?.(mp === 'wb' ? 'wb' : mp === 'ozon' ? 'ozon' : 'yandex');
            synced.push(mp.toUpperCase());
          }
        } catch (e) {
          synced.push(`${mp} (ошибка)`);
        }
      }
      return `Синхронизация запущена: ${synced.join(', ')}. Данные обновятся в течение 1-2 минут.`;
    },
  },
];

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

// ── Actions: аналитика ────────────────────────────────────────────────────────

const ANALYTICS_ACTIONS: AiAction[] = [
  {
    name: 'export_analytics_report',
    description: 'Создать Excel-отчёт с текущей аналитикой. Используй когда говорят «экспортируй отчёт», «создай отчёт», «выгрузи аналитику в Excel».',
    args: '{ title?: string }',
    run: async (a: { title?: string }) => {
      const am = w().analyticsModule;
      const kpi = am?.kpi;
      w().app?.navigateTo?.('docs');
      await new Promise(r => setTimeout(r, 1200));
      const dm = w().docsModule;
      if (!dm?.aiCreateDoc) return 'Открываю Редактор для создания отчёта. Нажмите «Новый Excel» и скопируйте данные из Аналитики.';

      const title = a.title ?? `Отчёт аналитики ${new Date().toLocaleDateString('ru-RU')}`;
      await dm.aiCreateDoc('excel', title);
      const docId = dm.activeDocId ?? '';

      if (kpi && docId) {
        const rows: [string, string | number][] = [
          ['Метрика', 'Значение'],
          ['Выручка нетто', kpi.revenue ?? 0],
          ['Выручка брутто', kpi.revenue_gross ?? 0],
          ['Заказов выполнено', kpi.orders_delivered ?? 0],
          ['В обработке', kpi.orders_processing ?? 0],
          ['Возвраты', kpi.orders_returned ?? 0],
          ['Отмены', kpi.orders_cancelled ?? 0],
          ['Маржа %', kpi.margin_pct ?? 0],
          ['Средний чек', kpi.avg_check ?? 0],
          ['Комиссии МП', kpi.commission ?? 0],
          ['Логистика', kpi.logistics ?? 0],
        ];
        for (let i = 0; i < rows.length; i++) {
          dm.aiExcelCommand(docId, 'set_cell', { row: i, col: 0, value: rows[i][0] });
          dm.aiExcelCommand(docId, 'set_cell', { row: i, col: 1, value: rows[i][1] });
        }
      }

      return `Отчёт «${title}» создан в Редакторе. Данные аналитики внесены в таблицу.`;
    },
  },
];

// ── Actions: заказы ───────────────────────────────────────────────────────────

const ORDERS_ACTIONS: AiAction[] = [
  {
    name: 'create_urgent_orders_task',
    description: 'Создать задачу по срочным заказам (с просрочкой или близко к дедлайну). Используй когда говорят «создай задачу по срочным заказам» или «отметь просроченные».',
    args: '{}',
    run: async () => {
      const orders: any[] = w().allOrdersModule?.orders ?? [];
      const urgent = orders.filter((o: any) => {
        const s = (o.status ?? '').toLowerCase();
        return s.includes('pending') || s.includes('new') || s.includes('awaiting');
      }).slice(0, 10);
      if (!urgent.length) return 'Срочных заказов не обнаружено — все в норме.';
      const { taskDb } = await import('@/services/taskDb');
      await taskDb.createTask({
        title: `Обработать ${urgent.length} срочных заказов`,
        description: `Заказы требующие обработки: ${urgent.slice(0, 5).map((o: any) => o.article ?? o.offer_id ?? o.nm_id ?? '—').join(', ')}`,
        status: 'todo', priority: 'red', scheduled_date: null,
        due_date: null, due_time: null, end_time: null, all_day: true,
        tags: 'Сима,Заказы', sort_order: 9999, parent_id: null, assignee_id: null,
      });
      w().taskManagerModule?.load?.();
      return `Создана задача: ${urgent.length} срочных заказов ждут обработки.`;
    },
  },
];

// ── Actions: производители ────────────────────────────────────────────────────

const PRODUCERS_ACTIONS: AiAction[] = [
  {
    name: 'create_reorder_tasks',
    description: 'Создать задачи на заказ товаров у поставщиков для всех OOS и критически низких позиций. Используй когда говорят «создай заявки поставщикам», «нужно заказать товары».',
    args: '{ threshold?: number }',
    run: async (a: { threshold?: number }) => {
      const minStock = a.threshold ?? 10;
      const items: any[] = w().stockModule?.items ?? [];
      const critical = items.filter((i: any) => (i.stockTotal ?? 0) < minStock);
      if (!critical.length) return `Все товары имеют остаток ≥ ${minStock} единиц. Срочных заказов не требуется.`;

      const { taskDb } = await import('@/services/taskDb');
      let created = 0;
      for (const item of critical.slice(0, 10)) {
        await taskDb.createTask({
          title: `Заказ поставщику: «${String(item.name || item.offerId).slice(0, 40)}»`,
          description: `Остаток: ${item.stockTotal ?? 0} ед. (${item.mp ?? 'МП'}). Необходимо пополнить запас.`,
          status: 'todo', priority: item.stockTotal === 0 ? 'red' : 'yellow',
          scheduled_date: null, due_date: null, due_time: null, end_time: null,
          all_day: true, tags: 'Сима,Поставка', sort_order: 9999, parent_id: null, assignee_id: null,
        });
        created++;
      }
      w().taskManagerModule?.load?.();
      return `Создано ${created} задач на пополнение запасов (остаток < ${minStock} ед.).`;
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
    'home':          HOME_ACTIONS,
    'products-hub':  PRODUCTS_HUB_ACTIONS,
    'tasks':         TASKS_ACTIONS,
    'reviews':       REVIEWS_ACTIONS,
    'repricer':      REPRICER_ACTIONS,
    'stock':         STOCK_ACTIONS,
    'analytics':     ANALYTICS_ACTIONS,
    'orders':        ORDERS_ACTIONS,
    'orders-ozon':   ORDERS_ACTIONS,
    'orders-wb':     ORDERS_ACTIONS,
    'orders-yandex': ORDERS_ACTIONS,
    'marketplaces':  MARKETPLACES_ACTIONS,
    'ozon':          MARKETPLACES_ACTIONS,
    'wb':            MARKETPLACES_ACTIONS,
    'yandex':        MARKETPLACES_ACTIONS,
    'producers':     PRODUCERS_ACTIONS,
  };
  const SUPPLY_ACTIONS: AiAction[] = [
    {
      name: 'get_ym_slots',
      description: 'Показать доступные слоты приёмки Яндекс Маркет FBY на ближайшие N дней. Используй когда пользователь спрашивает "какие даты доступны", "когда можно сдать", "слоты ЯМ".',
      args: '{ days?: number }',
      run: async (a: { days?: number }) => {
        const { getYandexAvailableSlots } = await import('@/services/yandexApi');
        const days = a?.days ?? 14;
        const slots = getYandexAvailableSlots(days);
        w().app?.navigateTo?.('supply');
        return `Доступные рабочие дни для отгрузки ЯМ (ближайшие ${days} рабочих дней):\n${slots.map(s => `  • ${s.label} (${s.date})`).join('\n')}\n\nДля создания отгрузки скажи: "Создай отгрузку на [дату]"`;
      },
    },
    {
      name: 'create_ym_shipment',
      description: 'Создать отгрузку Яндекс Маркет FBY на конкретную дату. Используй когда пользователь говорит "создай поставку [дата]", "запланируй отгрузку на [дату]".',
      args: '{ date: string, windowDays?: number }',
      run: async (a: { date: string; windowDays?: number }) => {
        if (!a?.date) return 'Укажи дату в формате YYYY-MM-DD, например: 2026-08-10';
        const sm = w().supplyModule;
        if (!sm) { w().app?.navigateTo?.('supply'); return 'Открываю раздел Поставки. Повтори команду через секунду.'; }
        const result = await sm.aiCreateYmShipment(a.date, a.windowDays ?? 2);
        return result;
      },
    },
    {
      name: 'create_wb_supply_from_orders',
      description: 'Создать поставку WB автоматически из всех новых заказов, ожидающих отгрузки.',
      args: '{ name?: string }',
      run: async (a: { name?: string }) => {
        const sm = w().supplyModule;
        if (!sm) { w().app?.navigateTo?.('supply'); return 'Открываю раздел Поставки. Повтори команду через секунду.'; }
        const result = await sm.aiCreateWbSupplyFromNewOrders(a?.name);
        return result;
      },
    },
    {
      name: 'get_supply_status',
      description: 'Показать статистику и список поставок. Используй когда пользователь спрашивает "сколько поставок", "статус поставок", "что в черновике".',
      args: '{}',
      run: async () => {
        const sm = w().supplyModule;
        if (!sm) return 'Раздел Поставки ещё не открыт.';
        const stats = sm.supplyStats ?? {};
        const supplies: any[] = sm.supplies ?? [];
        return `Поставки: черновик ${stats.draft ?? 0}, в пути ${stats.sending ?? 0}, принято ${stats.delivered ?? 0}, отменено ${stats.cancelled ?? 0}.\n${supplies.length ? supplies.slice(0, 5).map((s: any) => `• ${s.name} [${s.status}]`).join('\n') : 'Список пуст.'}`;
      },
    },
  ];

  const actions = PAGE_ACTIONS[page] ?? (page === 'supply' ? SUPPLY_ACTIONS : []);

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

  // Тема и перезагрузка — для команды из чата Симы
  aiPage.registerGlobal({
    name: 'toggle_theme_off',
    description: 'Переключить интерфейс на тёмную тему',
    args: '{}',
    run: async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('sd_theme', 'dark');
      return 'Тёмная тема включена';
    },
  });
  aiPage.registerGlobal({
    name: 'toggle_theme_on',
    description: 'Переключить интерфейс на светлую тему',
    args: '{}',
    run: async () => {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('sd_theme', 'light');
      return 'Светлая тема включена';
    },
  });
  aiPage.registerGlobal({
    name: 'reload_page',
    description: 'Перезагрузить страницу (обновить данные)',
    args: '{}',
    run: async () => { location.reload(); return 'Перезагрузка…'; },
  });

  // ── Навигация из любого места ───────────────────────────────────────────────
  aiPage.registerGlobal({
    name: 'navigate_to',
    description: 'Перейти в любой раздел SimaDesk из любого места. Используй когда нужно открыть раздел как часть цепочки действий.',
    args: '{ page: string }',
    run: async (a: { page: string }) => {
      w().app?.navigateTo?.(a.page);
      await new Promise(r => setTimeout(r, 600));
      return `Открыт раздел «${a.page}»`;
    },
  });

  // ── Создание задач из любого места ─────────────────────────────────────────
  aiPage.registerGlobal({
    name: 'create_task_global',
    description: 'Создать задачу из любого раздела системы без перехода в Задачи.',
    args: '{ title: string, description?: string, priority?: "red"|"yellow"|"blue"|"none", due_date?: string }',
    run: async (a: any) => {
      const { taskDb } = await import('@/services/taskDb');
      const task = await taskDb.createTask({
        title: a.title || 'Задача от Симы',
        description: a.description || '',
        status: 'todo',
        priority: a.priority || 'none',
        scheduled_date: null,
        due_date: a.due_date || null,
        due_time: null,
        end_time: null,
        all_day: true,
        tags: 'Сима',
        sort_order: 9999,
        parent_id: null,
        assignee_id: null,
      });
      w().taskManagerModule?.load?.();
      return `Задача создана: «${task.title}»`;
    },
  });

  // ── OOS — создать задачи по всем закончившимся товарам ──────────────────────
  aiPage.registerGlobal({
    name: 'create_oos_tasks',
    description: 'Создать задачи для ВСЕХ товаров с нулевым остатком (OOS). Используй когда говорят «создай задачи по OOS», «все закончившиеся товары в задачи».',
    args: '{}',
    run: async () => {
      const items: any[] = w().stockModule?.items ?? [];
      const oos = items.filter((i: any) => (i.stockTotal ?? 0) === 0);
      if (!oos.length) return 'OOS товаров не обнаружено — все в наличии!';
      const { taskDb } = await import('@/services/taskDb');
      let n = 0;
      for (const item of oos.slice(0, 20)) {
        await taskDb.createTask({
          title: `OOS: пополнить «${String(item.name || item.offerId).slice(0, 50)}»`,
          description: `Товар закончился на складе. МП: ${item.mp ?? '—'}. Срочно заказать у поставщика.`,
          status: 'todo', priority: 'red', scheduled_date: null,
          due_date: null, due_time: null, end_time: null, all_day: true,
          tags: 'Сима,OOS', sort_order: 9999, parent_id: null, assignee_id: null,
        });
        n++;
      }
      w().taskManagerModule?.load?.();
      return `Создано ${n} задач по OOS-товарам. ${oos.length > 20 ? `(Показаны первые 20 из ${oos.length})` : ''}`;
    },
  });

  // ── Массовое изменение цен ──────────────────────────────────────────────────
  aiPage.registerGlobal({
    name: 'bulk_price_change',
    description: 'Изменить цены ВСЕХ товаров на маркетплейсе на процент или сумму. Используй когда говорят «подними все цены на 10%», «скидка 500р на все товары», «снизь все цены на WB на 5%».',
    args: '{ mp: "wb"|"ozon"|"yandex", delta: number, percent?: boolean }',
    run: async (a: { mp: string; delta: number; percent?: boolean }) => {
      const pm = w().productsHubModule;
      if (!pm?.aiApplyPriceDelta) {
        w().app?.navigateTo?.('products-hub');
        await new Promise(r => setTimeout(r, 800));
        if (!w().productsHubModule?.aiApplyPriceDelta) {
          return `Массовое изменение цен: ${a.percent ? `${a.delta}%` : `${a.delta}₽`} на ${a.mp.toUpperCase()}. Откройте Products Hub и выделите все товары, затем используйте «Изменить цену».`;
        }
      }
      const result = await w().productsHubModule.aiApplyPriceDelta({
        mp: a.mp,
        delta: a.delta,
        percent: a.percent ?? false,
      });
      return typeof result === 'string' ? result : `Цены изменены на ${a.mp.toUpperCase()}: ${a.percent ? `${a.delta}%` : `${a.delta}₽`}`;
    },
  });

  // ── Генерация Excel-отчёта ──────────────────────────────────────────────────
  aiPage.registerGlobal({
    name: 'generate_report',
    description: 'Создать Excel-отчёт с данными магазина (аналитика, остатки, заказы). Используй когда говорят «создай отчёт», «экспортируй данные», «сделай сводку в Excel».',
    args: '{ type?: "analytics"|"stock"|"orders"|"full", title?: string }',
    run: async (a: { type?: string; title?: string }) => {
      w().app?.navigateTo?.('docs');
      await waitFor(() => !!w().docsModule?.aiCreateDoc, 2000);
      const dm = w().docsModule;
      if (!dm?.aiCreateDoc) return 'Редактор документов недоступен. Перейдите в раздел «Редактор» и создайте отчёт вручную.';

      const type = a.type ?? 'full';
      const title = a.title ?? `Отчёт SimaDesk ${new Date().toLocaleDateString('ru-RU')}`;
      await dm.aiCreateDoc('excel', title);
      await new Promise(r => setTimeout(r, 400));

      const lines: string[] = [`Отчёт создан: «${title}»`];

      if ((type === 'analytics' || type === 'full') && w().analyticsModule?.kpi) {
        const kpi = w().analyticsModule.kpi;
        lines.push(`Аналитика: выручка ${kpi.revenue?.toFixed(0)}₽, заказов ${(kpi.orders_delivered ?? 0) + (kpi.orders_processing ?? 0)}, маржа ${kpi.margin_pct?.toFixed(1)}%`);
      }
      if ((type === 'stock' || type === 'full') && w().stockModule?.items?.length) {
        const items = w().stockModule.items;
        const oos = items.filter((i: any) => (i.stockTotal ?? 0) === 0).length;
        lines.push(`Остатки: ${items.length} SKU, OOS: ${oos}`);
      }

      return lines.join('\n');
    },
  });

  // ── Полный аудит рисков ─────────────────────────────────────────────────────
  aiPage.registerGlobal({
    name: 'run_risk_audit',
    description: 'Выполнить полный автоматический аудит рисков магазина и создать задачи по найденным проблемам. Используй когда говорят «аудит рисков», «проверь всё», «найди все проблемы».',
    args: '{ create_tasks?: boolean }',
    run: async (a: { create_tasks?: boolean }) => {
      const risks: Array<{ text: string; priority: 'red'|'yellow' }> = [];

      // Остатки
      const items: any[] = w().stockModule?.items ?? [];
      const oos = items.filter((i: any) => (i.stockTotal ?? 0) === 0);
      const low = items.filter((i: any) => (i.stockTotal ?? 0) > 0 && (i.stockTotal ?? 0) < 10);
      if (oos.length) risks.push({ text: `OOS: ${oos.length} товаров без остатков`, priority: 'red' });
      if (low.length) risks.push({ text: `Критично мало (<10 ед): ${low.length} товаров`, priority: 'yellow' });

      // Задачи
      const tasks: any[] = w().taskManagerModule?.tasks ?? [];
      const overdue = tasks.filter((t: any) => t.status !== 'done' && t.due_date && new Date(t.due_date) < new Date());
      if (overdue.length) risks.push({ text: `Просроченных задач: ${overdue.length}`, priority: 'red' });

      // Отзывы
      const reviews: any[] = w().reviewsModule?.reviews ?? [];
      const badUnans = reviews.filter((r: any) => !r.answered && !r.answer && (r.stars ?? 5) <= 2);
      if (badUnans.length) risks.push({ text: `Негативных отзывов без ответа: ${badUnans.length}`, priority: 'yellow' });

      if (!risks.length) return 'Аудит завершён — критичных рисков не обнаружено! Магазин работает штатно.';

      if (a.create_tasks !== false) {
        const { taskDb } = await import('@/services/taskDb');
        for (const risk of risks) {
          await taskDb.createTask({
            title: `[Аудит] ${risk.text}`,
            description: `Обнаружено автоматическим аудитом Симы ${new Date().toLocaleDateString('ru-RU')}`,
            status: 'todo', priority: risk.priority, scheduled_date: null,
            due_date: null, due_time: null, end_time: null, all_day: true,
            tags: 'Сима,Аудит', sort_order: 9999, parent_id: null, assignee_id: null,
          });
        }
        w().taskManagerModule?.load?.();
      }

      return `Аудит завершён. Найдено ${risks.length} проблем:\n${risks.map(r => `${r.priority === 'red' ? '🔴' : '🟡'} ${r.text}`).join('\n')}${a.create_tasks !== false ? '\n\nЗадачи созданы в разделе Задачи.' : ''}`;
    },
  });

  // ── Ответить на все отзывы без ответа ──────────────────────────────────────
  aiPage.registerGlobal({
    name: 'reply_all_unanswered',
    description: 'Ответить на все отзывы без ответа стандартным текстом. Используй когда говорят «ответь на все отзывы», «обработай все без ответа». Принимает шаблон ответа.',
    args: '{ template?: string, stars_max?: number }',
    run: async (a: { template?: string; stars_max?: number }) => {
      const rm = w().reviewsModule;
      if (!rm) {
        w().app?.navigateTo?.('reviews');
        return 'Перехожу в раздел Отзывы. После загрузки повторите команду.';
      }
      const reviews: any[] = rm.reviews ?? rm.items ?? [];
      const maxStars = a.stars_max ?? 3;
      const unanswered = reviews.filter((r: any) => !r.answered && !r.answer && !r.reply && (r.stars ?? 5) <= maxStars);
      if (!unanswered.length) return `Отзывов без ответа (≤${maxStars}★) не найдено.`;

      const defaultTemplate = 'Спасибо за ваш отзыв! Мы приняли ваш комментарий к сведению и работаем над улучшением качества. Если у вас остались вопросы — свяжитесь с нами, мы обязательно поможем!';
      const template = a.template ?? defaultTemplate;

      let replied = 0;
      for (const review of unanswered.slice(0, 10)) {
        try {
          if (typeof rm.aiReplyReview === 'function') {
            await rm.aiReplyReview(review.id, template);
            replied++;
          }
        } catch { /* continue */ }
      }

      if (!replied) return `Найдено ${unanswered.length} отзывов без ответа. Перейдите в раздел «Отзывы» и ответьте вручную — или убедитесь что маркетплейс подключён.`;
      return `Ответил на ${replied} отзыв(а) из ${unanswered.length}. Текст: «${template.slice(0, 60)}…»`;
    },
  });
}
