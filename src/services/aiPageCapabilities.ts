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
import { recordDailyTokens } from './aiTokenQuota';

const w = () => window as any;
const fmtRub = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} млн ₽`
  : n >= 1_000 ? `${(n / 1_000).toFixed(0)} тыс ₽`
  : `${Math.round(n)} ₽`;

const MP_NAME: Record<string, string> = {
  ozon: 'Ozon', wb: 'Wildberries', yandex: 'Яндекс Маркет',
};

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
  const kpi = (am as any)?.kpi;
  if (!kpi) return 'Раздел аналитики. Данные ещё не загружены — попроси открыть/обновить.';

  let out = `Аналитика (текущий период):
Выручка нетто: ${fmtRub(kpi.revenue)} | Валовая: ${fmtRub(kpi.revenue_gross ?? 0)}
Заказов: ${(kpi.orders_delivered ?? 0) + (kpi.orders_processing ?? 0)} | Возвраты: ${kpi.orders_returned ?? 0} | Отмены: ${kpi.orders_cancelled ?? 0}
Маржа: ${kpi.margin_pct?.toFixed?.(1) ?? '—'}% | Ср. чек: ${fmtRub(kpi.avg_check ?? 0)}
Комиссии МП: ${fmtRub(kpi.commission ?? 0)} | Логистика: ${fmtRub(kpi.logistics ?? 0)}`;

  // Топ-SKU — агрегируем из orders.items
  const orders: any[] = (am as any)?.orders ?? [];
  if (orders.length > 0) {
    const bySkuMap: Record<string, { name: string; qty: number; revenue: number; profit: number }> = {};
    for (const order of orders) {
      for (const item of (order.items ?? [])) {
        const key = item.vendor_code || item.name || '—';
        if (!bySkuMap[key]) bySkuMap[key] = { name: item.name || key, qty: 0, revenue: 0, profit: 0 };
        bySkuMap[key].qty     += item.quantity  ?? 0;
        bySkuMap[key].revenue += item.revenue   ?? 0;
        bySkuMap[key].profit  += item.net_profit ?? 0;
      }
    }
    const skus = Object.entries(bySkuMap)
      .map(([vc, d]) => ({ vc, ...d }))
      .sort((a, b) => b.revenue - a.revenue);

    if (skus.length > 0) {
      out += `\n\nТоп-${Math.min(10, skus.length)} SKU по выручке:`;
      skus.slice(0, 10).forEach((s, i) => {
        const marginStr = s.revenue > 0 ? ` маржа ${(s.profit / s.revenue * 100).toFixed(0)}%` : '';
        out += `\n${i + 1}. [${s.vc}] «${s.name.slice(0, 40)}» — ${fmtRub(s.revenue)} (${s.qty} шт${marginStr})`;
      });

      // Аутсайдеры — последние 5 по выручке (только если SKU > 15)
      if (skus.length > 15) {
        out += `\n\nАутсайдеры (меньше всего выручки):`;
        skus.slice(-5).reverse().forEach((s, i) => {
          out += `\n${i + 1}. [${s.vc}] «${s.name.slice(0, 40)}» — ${fmtRub(s.revenue)} (${s.qty} шт)`;
        });
      }
    }
  }

  return out;
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
  if (!rm) return 'Раздел отзывов. Модуль недоступен.';

  // allReviews — публичный getter, возвращает все отзывы из всех магазинов
  const reviews: any[] = rm.allReviews ?? [];
  const activeMp: string = (rm as any).activeMp ?? '';

  if (!reviews.length) {
    return `Раздел отзывов (активная вкладка: ${activeMp || 'не выбрана'}). Отзывы ещё не загружены — используй fetch_reviews чтобы загрузить.`;
  }

  const unanswered = reviews.filter((r: any) => !r.answered);
  const neg = unanswered.filter((r: any) => r.rating <= 2);
  const mpLabel: Record<string, string> = { wb: 'WB', ozon: 'Ozon', yandex: 'ЯМ' };

  let out = `Отзывы (вкладка ${mpLabel[activeMp] ?? activeMp}): всего ${reviews.length}, без ответа ${unanswered.length} (негативных ≤2★: ${neg.length}).`;

  if (unanswered.length > 0) {
    out += '\n\nОтзывы без ответа (до 15):';
    unanswered.slice(0, 15).forEach((r: any, i: number) => {
      const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
      const product = (r.productName ?? '').toString().slice(0, 40);
      const sku = r.productSku ? ` [${r.productSku}]` : '';
      out += `\n${i + 1}. ${r.rating}★ ${dateStr}${sku}${product ? ' — ' + product : ''}`;
      if (r.text) out += `\n   "${r.text.slice(0, 200)}"`;
    });
  }

  return out;
}

function describeAdvertising(): string {
  const am = w().advertisingModule;
  if (!am) return 'Раздел Реклама. Модуль ещё не загружен — перейди в раздел Реклама и повтори.';

  const campaigns: any[] = am.campaigns ?? [];
  if (!campaigns.length) {
    return `Реклама: вкладка ${am.tab ?? '—'}. Кампании ещё не загружены — попроси загрузить данные.`;
  }

  const active = campaigns.filter(c => c.status === 'active');
  const paused = campaigns.filter(c => c.status !== 'active');
  const totalBudget = campaigns.reduce((s: number, c: any) => s + (c.budget ?? 0), 0);
  const totalSpent  = campaigns.reduce((s: number, c: any) => s + (c.spent  ?? 0), 0);
  const totalOrders = campaigns.reduce((s: number, c: any) => s + (c.orders ?? 0), 0);

  let out = `Реклама (${am.tab?.toUpperCase() ?? ''}): кампаний ${campaigns.length} (активных: ${active.length}, на паузе: ${paused.length}).`;
  out += `\nДневной бюджет: ${fmtRub(totalBudget)} | Потрачено: ${fmtRub(totalSpent)} | Заказов: ${totalOrders}`;

  // Проблемные — убыточные и сжигающие бюджет
  const problems = active.filter(c => (c.roi ?? 0) < -15 && (c.spent ?? 0) > 200);
  if (problems.length) out += `\n⚠ Убыточных кампаний (ROI < -15%): ${problems.length} — ${problems.map(c => `"${c.name}"(ROI ${c.roi?.toFixed(0)}%)`).join(', ')}`;

  out += '\n\nВсе кампании:';
  campaigns.slice(0, 12).forEach(c => {
    const ctrStr = c.views > 0 ? (c.clicks / c.views * 100).toFixed(2) : '—';
    out += `\n• [id:${c.id}] "${c.name}" [${c.status}] бюджет ${fmtRub(c.budget)} потрачено ${fmtRub(c.spent)} CTR ${ctrStr}% ROI ${c.roi?.toFixed(0) ?? '—'}% заказов ${c.orders ?? 0}`;
  });

  return out;
}

function describeRepricer(): string {
  const rep = w().repricerModule;
  if (!rep) return 'Раздел Репрайсера. Управляет автоматическим изменением цен. Стратегии: следить за конкурентами, целевая маржа, удержание позиции. Создай первое правило: выбери товар → «Добавить правило».';
  const rules: any[] = rep.rules ?? [];
  const items: any[] = rep.items ?? rep.skus ?? [];
  if (!rules.length && !items.length) return 'Репрайсер: правил нет, товары не добавлены. Создай первое правило — выбери SKU → «Добавить правило» → стратегия + мин/макс цена.';

  const byStrategy: Record<string, number> = {};
  rules.forEach((r: any) => { const s = r.strategy ?? r.type ?? 'unknown'; byStrategy[s] = (byStrategy[s] || 0) + 1; });
  const noMinMax = rules.filter((r: any) => !r.min_price && !r.max_price);
  const byMp: Record<string, number> = {};
  rules.forEach((r: any) => { const m = r.mp ?? '—'; byMp[m] = (byMp[m] || 0) + 1; });

  let out = `Репрайсер: ${rules.length} правил, ${items.length} SKU под управлением.`;
  if (Object.keys(byStrategy).length) out += `\nСтратегии: ${Object.entries(byStrategy).map(([s, n]) => `${s}: ${n}`).join(', ')}`;
  if (Object.keys(byMp).length > 1) out += `\nПо МП: ${Object.entries(byMp).map(([m, n]) => `${m}: ${n}`).join(', ')}`;
  if (noMinMax.length) out += `\n⚠ Правил без мин/макс цены: ${noMinMax.length} — риск уйти в убыток!`;
  if (rules.length > 0) {
    out += `\n\nПравила (первые 5):`;
    rules.slice(0, 5).forEach((r: any, i: number) => {
      out += `\n${i + 1}. [id:${r.id}] "${r.name ?? 'без названия'}" [${r.mp ?? '—'}] ${r.strategy ?? r.type ?? ''} мин:${r.min_price ?? '—'}₽ макс:${r.max_price ?? '—'}₽`;
    });
  }
  return out;
}

function describeProducers(): string {
  const pm = w().producersModule;
  if (!pm) return 'Раздел Производители / Поставщики. Хранит контакты, условия, прайсы и историю заказов поставщиков. Связан с Остатками для планирования поставок.';
  const suppliers: any[] = pm.suppliers ?? pm.producers ?? pm.items ?? [];
  if (!suppliers.length) return 'Производители: список поставщиков пуст. Добавь первого через кнопку «+» в разделе.';

  let out = `Производители: ${suppliers.length} поставщиков в базе.`;
  const withContacts = suppliers.filter((s: any) => s.phone || s.email || s.contact_name);
  if (withContacts.length < suppliers.length) out += ` Без контактов: ${suppliers.length - withContacts.length}.`;

  out += `\n\nПоставщики (первые 8):`;
  suppliers.slice(0, 8).forEach((s: any, i: number) => {
    const name = s.name ?? s.company_name ?? 'без названия';
    const contact = s.contact_name ?? s.contact ?? '';
    const phone = s.phone ?? '';
    const email = s.email ?? '';
    out += `\n${i + 1}. "${name}"${contact ? ' — ' + contact : ''}${phone ? ' ' + phone : ''}${email ? ' ' + email : ''}`;
  });
  return out;
}

function describeSimaStore(): string {
  const sm = w().simaStoreModule ?? w().simastore ?? w().storeModule;
  if (!sm) return 'Раздел Витрины (SimaStore). Собственный интернет-магазин без маркетплейса. URL: /s/slug. Товары берутся из Products Hub. Подключи оплату и доставку в настройках витрины.';

  const slug = sm.slug ?? sm.storeSlug ?? sm.store?.slug ?? '';
  const published = sm.published ?? sm.isPublished ?? sm.store?.published ?? false;
  const products: any[] = sm.products ?? sm.items ?? sm.store?.products ?? [];
  const paymentEnabled = sm.paymentEnabled ?? sm.payment_enabled ?? sm.store?.payment_enabled ?? false;
  const deliveryEnabled = sm.deliveryEnabled ?? sm.delivery_enabled ?? sm.store?.delivery_enabled ?? false;

  let out = `Витрина SimaStore: ${published ? '🟢 опубликована' : '⚪ не опубликована'}.`;
  if (slug) out += `\nURL: /s/${slug}`;
  out += `\nТоваров: ${products.length}`;
  out += `\nОплата: ${paymentEnabled ? '✅ подключена' : '❌ не настроена'} | Доставка: ${deliveryEnabled ? '✅ настроена' : '❌ не настроена'}`;
  if (!published) out += `\n💡 Для публикации: настройки витрины → «Опубликовать». Убедись что подключены оплата и доставка.`;
  return out;
}

function describeSettings(): string {
  const stm = w().settingsModule;
  const parts: string[] = ['Раздел Настройки SimaDesk.'];

  const team: any[] = stm?.team ?? stm?.users ?? w().companyModule?.users ?? [];
  if (team.length) parts.push(`Команда: ${team.length} пользователей (добавить: Настройки → Команда → «Пригласить»).`);

  const wbConn = !!(w().wbModule?.connected || stm?.wbKey);
  const ozConn = !!(w().ozonModule?.connected || stm?.ozonKey);
  const ymConn = !!(w().yandexModule?.connected || stm?.ymKey);
  parts.push(`Маркетплейсы: WB ${wbConn ? '✅' : '❌'} | Ozon ${ozConn ? '✅' : '❌'} | ЯМ ${ymConn ? '✅' : '❌'}`);

  const aiKey = sessionStorage.getItem('sd_ai_key') ?? stm?.aiKey ?? '';
  parts.push(`AI-ассистент (Сима): ${aiKey ? '✅ ключ настроен' : '❌ ключ не настроен — без ключа Сима не работает. Настройки → AI → вставь OpenRouter API-ключ.'}`);

  const sub = stm?.subscription ?? stm?.plan ?? w().companyModule?.subscription;
  if (sub) parts.push(`Подписка: ${sub.name ?? sub.plan ?? sub.tier ?? 'активна'}`);

  return parts.join('\n');
}

function describeMarketplaces(): string {
  const wbm = w().wbModule;
  const ozm = w().ozonModule;
  const ymm = w().yandexModule;

  const lines: string[] = ['Раздел Маркетплейсы — подключение API-аккаунтов.'];

  if (wbm) {
    const name = wbm.shopName ?? '';
    lines.push(`Wildberries: ${wbm.connected ? `✅ подключён${name ? ' (' + name + ')' : ''}` : '❌ не подключён — нужен токен из ЛК WB → Профиль → Токены API'}`);
  } else {
    lines.push('Wildberries: статус неизвестен (модуль не загружен — перейди в раздел Маркетплейсы)');
  }

  if (ozm) {
    const name = ozm.shopName ?? '';
    lines.push(`Ozon: ${ozm.connected ? `✅ подключён${name ? ' (' + name + ')' : ''}` : '❌ не подключён — нужен ключ из ЛК Ozon → API → Ключи'}`);
  } else {
    lines.push('Ozon: статус неизвестен');
  }

  if (ymm) {
    const name = ymm.shopName ?? '';
    lines.push(`Яндекс Маркет: ${ymm.connected ? `✅ подключён${name ? ' (' + name + ')' : ''}` : '❌ не подключён — нужен OAuth-токен из ЛК ЯМ → Настройки → API'}`);
  } else {
    lines.push('Яндекс Маркет: статус неизвестен');
  }

  lines.push('\nПосле вставки ключа первая синхронизация занимает 15–30 мин. Если синхронизация не идёт — проверь права ключа.');
  return lines.join('\n');
}

function describeHome(): string {
  const lines: string[] = ['Пользователь на Главной (дашборд). Сима ВИДИТ сводку по всему магазину:'];

  // Analytics KPI
  const am = w().analyticsModule;
  if (am?.kpi) {
    const k = am.kpi;
    const rev = k.revenue != null ? `выручка нетто ${k.revenue.toFixed(0)}₽` : null;
    const margin = k.margin_pct != null ? `маржа ${k.margin_pct.toFixed(1)}%` : null;
    const orders = (k.orders_delivered ?? 0) + (k.orders_processing ?? 0);
    lines.push(`Аналитика: ${[rev, margin, orders ? `заказов ${orders}` : null].filter(Boolean).join(', ')}`);
  }

  // Stock OOS
  const sm = w().stockModule;
  if (sm?.items?.length) {
    const items: any[] = sm.items;
    const oos = items.filter((i: any) => (i.stockTotal ?? 0) === 0).length;
    const low = items.filter((i: any) => (i.stockTotal ?? 0) > 0 && (i.stockTotal ?? 0) < 10).length;
    lines.push(`Склад: ${items.length} SKU, OOS ${oos}, критично мало (<10 ед) ${low}`);
  }

  // Tasks overdue
  const tm = w().taskManagerModule;
  if (tm?.tasks?.length) {
    const tasks: any[] = tm.tasks;
    const overdue = tasks.filter((t: any) => t.status !== 'done' && t.due_date && new Date(t.due_date) < new Date()).length;
    const todo = tasks.filter((t: any) => t.status === 'todo').length;
    lines.push(`Задачи: ${todo} в работе, ${overdue} просроченных`);
  }

  // Reviews unanswered
  const rm = w().reviewsModule;
  if (rm) {
    const reviews: any[] = rm.allReviews ?? [];
    const unans = reviews.filter((r: any) => !r.answered && !r.answer && !r.reply).length;
    const neg = reviews.filter((r: any) => !r.answered && !r.answer && !r.reply && (r.stars ?? 5) <= 2).length;
    if (unans > 0) lines.push(`Отзывы: ${unans} без ответа${neg ? `, из них ${neg} негативных` : ''}`);
  }

  // Ads budget
  const adm = w().advertisingModule;
  if (adm?.campaigns?.length) {
    const campaigns: any[] = adm.campaigns;
    const active = campaigns.filter((c: any) => c.status === 'active').length;
    const totalSpent = campaigns.reduce((s: number, c: any) => s + (c.spent ?? 0), 0);
    lines.push(`Реклама: ${active} активных кампаний, расход ${totalSpent.toFixed(0)}₽`);
  }

  if (lines.length === 1) {
    lines.push('Данные модулей ещё не загружены — попроси пользователя перейти в нужный раздел для получения актуальной информации.');
  }
  return lines.join('\n');
}

function describeGeneric(page: string): string {
  const title = PAGE_TITLE[page] ?? page;
  return `Открыт раздел «${title}». Можешь помочь пользователю разобраться с ним, подсказать действия и, если попросят, перейти в другой раздел.`;
}

// ── Кнопки-подсказки по разделам ────────────────────────────────────────────────

const SUGGESTIONS: Record<string, AiSuggestion[]> = {
  home: [
    { label: '🧭 Сводка по бизнесу', prompt: 'Дай полную сводку по бизнесу: магазины, остатки, задачи, отзывы, реклама' },
    { label: '📉 Что заканчивается', prompt: 'Проверь остатки по всем магазинам: что закончилось и что заканчивается' },
    { label: '⚠️ Найди риски', prompt: 'Проанализируй данные и найди риски (остатки, заказы, цены)' },
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
    { label: '🤖 Ответь на первый', prompt: 'Сгенерируй AI-ответ на первый отзыв без ответа и опубликуй' },
    { label: '🤖 Ответь на все', prompt: 'Ответь AI-ответами на все отзывы без ответа (до 10)' },
    { label: '😡 Разбор негатива', prompt: 'Покажи все негативные отзывы (1-2★) без ответа и предложи что написать' },
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
    { label: '📊 Сводка по кампаниям', prompt: 'Дай детальную сводку по рекламным кампаниям: CTR, ROI, бюджет, заказы' },
    { label: '💸 Лучший и худший ROI', prompt: 'Покажи кампании отсортированные по ROI — лучшие и убыточные' },
    { label: '⏸ Что остановить', prompt: 'Какие кампании убыточны (ROI < -15%) и их стоит поставить на паузу?' },
    { label: '💰 Бюджеты кампаний', prompt: 'Покажи бюджеты всех кампаний — где бюджет исчерпан, где есть запас' },
  ],
});

// ── Сборка капабилити для страницы ───────────────────────────────────────────────

const DESCRIBERS: Record<string, () => string> = {
  home: describeHome,
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
  advertising: describeAdvertising,
  repricer: describeRepricer,
  producers: describeProducers,
  simastore: describeSimaStore,
  settings: describeSettings,
  profile: describeSettings,
  marketplaces: describeMarketplaces,
  ozon: describeMarketplaces,
  wb: describeMarketplaces,
  yandex: describeMarketplaces,
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
      const reviews: any[] = w().reviewsModule?.allReviews ?? [];
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
      const failed: string[] = [];
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
            const page = mp === 'wb' ? 'wb' : mp === 'ozon' ? 'ozon' : 'yandex';
            app?.navigateTo?.(page);
            failed.push(`${mp.toUpperCase()} (открываю раздел — нажми «Обновить» вручную)`);
          }
        } catch (e) {
          synced.push(`${mp} (ошибка: ${(e as Error)?.message ?? e})`);
        }
      }
      const parts: string[] = [];
      if (synced.length) parts.push(`Синхронизировано: ${synced.join(', ')}.`);
      if (failed.length) parts.push(failed.join(', ') + '.');
      return parts.join('\n') || 'Нет доступных модулей для синхронизации.';
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
  {
    name: 'edit_task',
    description: 'Изменить название, описание, приоритет или дату задачи по её текущему названию. Используй когда говорят «переименуй задачу X в Y», «поменяй приоритет задачи», «перенеси задачу X на [дату]».',
    args: '{ title: string, new_title?: string, description?: string, priority?: "red"|"yellow"|"blue"|"none", due_date?: string }',
    run: async (a: { title: string; new_title?: string; description?: string; priority?: string; due_date?: string }) => {
      const tm = w().taskManagerModule;
      const tasks: any[] = tm?.tasks ?? [];
      const needle = (a.title || '').toLowerCase().trim();
      const task = tasks.find(t => t.title.toLowerCase().includes(needle));
      if (!task) throw new Error(`Задача «${a.title}» не найдена`);
      const { taskDb } = await import('@/services/taskDb');
      const updates: Record<string, any> = {};
      if (a.new_title) updates.title = a.new_title;
      if (a.description !== undefined) updates.description = a.description;
      if (a.priority) updates.priority = a.priority;
      if (a.due_date) updates.due_date = a.due_date;
      if (!Object.keys(updates).length) throw new Error('Не указано что именно изменить в задаче');
      await taskDb.updateTask(task.id, updates);
      tm?.load?.();
      const changed = Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(', ');
      return `Задача «${task.title}» обновлена: ${changed}`;
    },
  },
  {
    name: 'delete_task',
    description: 'Удалить задачу по названию. Используй только когда пользователь явно просит удалить/убрать задачу, а не выполнить её. ОБЯЗАТЕЛЬНО спроси подтверждение перед удалением.',
    args: '{ title: string }',
    run: async (a: { title: string }) => {
      const tm = w().taskManagerModule;
      const tasks: any[] = tm?.tasks ?? [];
      const needle = (a.title || '').toLowerCase().trim();
      const task = tasks.find(t => t.title.toLowerCase().includes(needle));
      if (!task) throw new Error(`Задача «${a.title}» не найдена`);
      const { taskDb } = await import('@/services/taskDb');
      await taskDb.deleteTask(task.id);
      tm?.load?.();
      return `Задача «${task.title}» удалена`;
    },
  },
];

// ── AI helper: генерация ответа на отзыв ──────────────────────────────────────

async function generateAiReply(text: string, stars: number, productName: string): Promise<string> {
  const key = sessionStorage.getItem('sd_ai_key') ?? '';
  if (!key) throw new Error('AI-ключ не настроен. Перейди в Настройки → AI-ассистент.');

  const tone = stars <= 2
    ? 'Тон: сочувствующий, извиняющийся, предлагай решение.'
    : stars === 3
      ? 'Тон: благодарный, уточни что можно улучшить.'
      : 'Тон: тёплый, краткий, поблагодари.';

  const prompt = `Ты — специалист по работе с клиентами маркетплейса. Напиши профессиональный ответ на отзыв покупателя от имени продавца.

Отзыв (${stars}★): "${text}"${productName ? `\nТовар: ${productName}` : ''}

${tone}
Требования: 2–4 предложения, максимум 300 символов, живой текст без шаблонных фраз, только текст ответа без кавычек и подписей.`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'SimaDesk Reviews',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4-5',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.75,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`AI API ${res.status}: ${err}`);
  }
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!reply) throw new Error('AI вернул пустой ответ');
  const tokens = data.usage?.total_tokens;
  if (tokens) recordDailyTokens(tokens);
  return reply;
}

async function publishReviewReply(rm: any, review: any, text: string): Promise<void> {
  if (typeof rm.aiReplyReview === 'function') {
    await rm.aiReplyReview(review.id, text);
    return;
  }
  const { dbFetch } = await import('@/services/dbClient');
  await dbFetch(`/rest/v1/reviews?id=eq.${review.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ answer: text, answered: true }),
  });
  rm.load?.();
}

// ── Actions: отзывы ──────────────────────────────────────────────────────────────

const REVIEWS_ACTIONS: AiAction[] = [
  {
    name: 'reply_review',
    description: 'Опубликовать ГОТОВЫЙ текст ответа на конкретный отзыв. Используй когда пользователь сам написал текст ответа и просит опубликовать. Если review_id не передан — берёт первый без ответа.',
    args: '{ text: string, review_id?: string }',
    run: async (a: { text: string; review_id?: string }) => {
      const rm = w().reviewsModule;
      if (!rm) throw new Error('Модуль отзывов недоступен на этой странице');
      const reviews: any[] = rm.allReviews ?? [];
      const review = a.review_id
        ? reviews.find(r => String(r.id) === String(a.review_id))
        : reviews.find(r => !r.answered && !r.answer && !r.reply);
      if (!review) throw new Error('Отзыв не найден. Возможно, все отзывы уже обработаны');
      await publishReviewReply(rm, review, a.text);
      return `Ответ на отзыв ${review.stars ?? '?'}★ опубликован: «${a.text.slice(0, 80)}${a.text.length > 80 ? '…' : ''}»`;
    },
  },
  {
    name: 'ai_generate_review_reply',
    description: 'Сгенерировать персонализированный AI-ответ на отзыв и опубликовать его. Используй когда говорят «ответь на этот отзыв», «напиши ответ на отзыв id:X», «сгенерируй ответ». Если review_id не указан — берёт первый без ответа.',
    args: '{ review_id?: string }',
    run: async (a: { review_id?: string }) => {
      let rm = w().reviewsModule;
      if (!rm) {
        w().app?.navigateTo?.('reviews');
        await waitFor(() => !!w().reviewsModule, 2500);
        rm = w().reviewsModule;
        if (!rm) return 'Открываю Отзывы — после загрузки страницы повтори команду.';
      }
      const reviews: any[] = rm.allReviews ?? [];
      const review = a.review_id
        ? reviews.find(r => String(r.id) === String(a.review_id))
        : reviews.find(r => !r.answered && !r.answer && !r.reply);
      if (!review) throw new Error('Отзыв без ответа не найден — возможно, все уже обработаны');
      const text = (review.text ?? review.comment ?? '').toString();
      const stars = review.stars ?? 5;
      const product = (review.productName ?? review.product_name ?? '').toString();
      const generated = await generateAiReply(text, stars, product);
      await publishReviewReply(rm, review, generated);
      return `Ответ на отзыв ${stars}★ сгенерирован и опубликован:\n\n«${generated}»`;
    },
  },
];

// ── Actions: реклама ──────────────────────────────────────────────────────────────

const ADVERTISING_ACTIONS: AiAction[] = [
  {
    name: 'toggle_campaign',
    description: 'Поставить рекламную кампанию на паузу или возобновить. Используй когда говорят «останови кампанию X», «возобнови кампанию», «пауза на рекламу X». campaign_id — id из контекста, action — "pause" или "resume".',
    args: '{ campaign_id: string|number, action: "pause"|"resume" }',
    run: async (a: { campaign_id: string | number; action: 'pause' | 'resume' }) => {
      const am = w().advertisingModule;
      if (!am) throw new Error('Модуль рекламы недоступен — перейди в раздел Реклама');
      if (typeof am.aiToggleCampaign === 'function') {
        return await am.aiToggleCampaign(a.campaign_id, a.action);
      }
      const campaigns: any[] = am.campaigns ?? [];
      const c = campaigns.find(x => String(x.id) === String(a.campaign_id));
      const name = c?.name ?? `id:${a.campaign_id}`;
      const action = a.action === 'pause' ? 'остановить' : 'возобновить';
      w().app?.navigateTo?.('advertising');
      return `Найди кампанию «${name}» в разделе Реклама и ${action} её вручную — API управления кампаниями пока не подключён напрямую.`;
    },
  },
  {
    name: 'set_campaign_budget',
    description: 'Изменить дневной бюджет рекламной кампании. Используй когда говорят «установи бюджет X рублей для кампании Y», «увеличь бюджет кампании до X».',
    args: '{ campaign_id: string|number, budget: number }',
    run: async (a: { campaign_id: string | number; budget: number }) => {
      const am = w().advertisingModule;
      if (!am) throw new Error('Модуль рекламы недоступен — перейди в раздел Реклама');
      if (typeof am.aiSetBudget === 'function') {
        return await am.aiSetBudget(a.campaign_id, a.budget);
      }
      const campaigns: any[] = am.campaigns ?? [];
      const c = campaigns.find(x => String(x.id) === String(a.campaign_id));
      const name = c?.name ?? `id:${a.campaign_id}`;
      w().app?.navigateTo?.('advertising');
      return `Открываю Рекламу. Найди кампанию «${name}» → нажми на бюджет и введи ${a.budget} ₽.`;
    },
  },
  {
    name: 'get_ad_stats',
    description: 'Показать детальную аналитику по рекламным кампаниям: ROI, CTR, расход бюджета, убыточные. Используй когда говорят «какая реклама работает», «ROI по кампаниям», «где лучший CTR», «что остановить».',
    args: '{ sort?: "roi"|"spent"|"orders"|"ctr", only_active?: boolean }',
    run: async (a: { sort?: string; only_active?: boolean }) => {
      const am = w().advertisingModule;
      if (!am) { w().app?.navigateTo?.('advertising'); return 'Открываю Рекламу. После загрузки данных повтори команду.'; }
      let campaigns: any[] = am.campaigns ?? [];
      if (!campaigns.length) return 'Кампании ещё не загружены. Перейди в раздел Реклама.';
      if (a.only_active) campaigns = campaigns.filter(c => c.status === 'active');

      const sort = a.sort ?? 'roi';
      campaigns = [...campaigns].sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0));

      const profitable = campaigns.filter(c => (c.roi ?? 0) > 0);
      const loss = campaigns.filter(c => (c.roi ?? 0) < -15 && (c.spent ?? 0) > 200);

      let out = `Реклама: ${campaigns.length} кампаний (рентабельных: ${profitable.length}, убыточных ROI<-15%: ${loss.length})\n`;
      campaigns.slice(0, 10).forEach(c => {
        const ctrStr = c.views > 0 ? (c.clicks / c.views * 100).toFixed(2) + '%' : '—';
        const roi = c.roi != null ? (c.roi >= 0 ? '+' : '') + c.roi.toFixed(0) + '%' : '—';
        out += `\n${c.status === 'active' ? '▶' : '⏸'} "${c.name}" ROI ${roi} CTR ${ctrStr} бюджет ${fmtRub(c.budget)} потрачено ${fmtRub(c.spent)} заказов ${c.orders ?? 0}`;
      });
      if (loss.length) out += `\n\n⚠ Рекомендую остановить убыточные: ${loss.map(c => `"${c.name}"(ROI ${c.roi?.toFixed(0)}%)`).join(', ')}`;
      return out;
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
  {
    name: 'hide_product',
    description: 'Скрыть товар (перевести в статус «скрыт»). Используй когда говорят «скрой товар», «снять с продажи», «выключи артикул». Требует подтверждения.',
    args: '{ article: string, mp?: "wb"|"ozon"|"yandex" }',
    run: async (a: { article: string; mp?: string }) => {
      const pm = w().productsHubModule;
      if (typeof pm?.aiHideProduct === 'function') return await pm.aiHideProduct(a);
      const items: any[] = pm?.items ?? [];
      const item = items.find((i: any) => {
        const art = (i.vendor_code ?? i.offer_id ?? i.article ?? i.nm_id ?? '').toString();
        return art.toLowerCase() === (a.article || '').toLowerCase();
      });
      if (!item) throw new Error(`Товар «${a.article}» не найден в каталоге`);
      w().app?.navigateTo?.('products-hub');
      return `Товар «${item.name ?? a.article}» найден. Скрытие через API пока недоступно — откройте карточку товара в разделе Товары и измените статус на «Скрыт» вручную.`;
    },
  },
  {
    name: 'show_product',
    description: 'Показать скрытый товар (перевести в статус «активен»). Используй когда говорят «покажи товар», «снова в продажу», «активируй артикул».',
    args: '{ article: string, mp?: "wb"|"ozon"|"yandex" }',
    run: async (a: { article: string; mp?: string }) => {
      const pm = w().productsHubModule;
      if (typeof pm?.aiShowProduct === 'function') return await pm.aiShowProduct(a);
      const items: any[] = pm?.items ?? [];
      const item = items.find((i: any) => {
        const art = (i.vendor_code ?? i.offer_id ?? i.article ?? i.nm_id ?? '').toString();
        return art.toLowerCase() === (a.article || '').toLowerCase();
      });
      if (!item) throw new Error(`Товар «${a.article}» не найден в каталоге`);
      w().app?.navigateTo?.('products-hub');
      return `Товар «${item.name ?? a.article}» найден. Активация через API пока недоступна — откройте карточку товара в разделе Товары и измените статус на «Активен» вручную.`;
    },
  },
  {
    name: 'update_product_description',
    description: 'Обновить название, описание или характеристики товара по артикулу. Используй когда говорят «измени описание товара X», «обнови SEO-описание», «переименуй артикул Y». Если не указан артикул — попроси уточнить.',
    args: '{ article: string, name?: string, description?: string, mp?: "wb"|"ozon"|"yandex" }',
    run: async (a: { article: string; name?: string; description?: string; mp?: string }) => {
      const pm = w().productsHubModule;
      if (typeof pm?.aiUpdateDescription === 'function') {
        return await pm.aiUpdateDescription(a);
      }
      const items: any[] = pm?.items ?? [];
      const item = items.find((i: any) => {
        const art = (i.vendor_code ?? i.offer_id ?? i.article ?? i.nm_id ?? '').toString();
        return art.toLowerCase() === (a.article || '').toLowerCase();
      });
      if (!item) throw new Error(`Товар с артикулом «${a.article}» не найден в загруженном каталоге`);
      const changes = [];
      if (a.name) changes.push(`Новое название: «${a.name}»`);
      if (a.description) changes.push(`Описание обновлено (${a.description.length} символов)`);
      if (!changes.length) throw new Error('Не указано что изменить — укажи name или description');
      w().app?.navigateTo?.('products-hub');
      return `Товар «${item.name ?? a.article}» найден. ${changes.join('; ')}. API редактирования описания пока не подключён напрямую — откройте карточку товара в разделе Товары и внесите изменения вручную.`;
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
      await waitFor(() => !!w().docsModule?.aiCreateDoc, 3000);
      const dm = w().docsModule;
      if (!dm?.aiCreateDoc) return 'Редактор не загрузился. Перейди в раздел «Редактор» вручную и создай Excel там.';

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

      const dataInserted = !!(kpi && docId);
      return `Отчёт «${title}» создан в Редакторе.${dataInserted ? ' Данные аналитики внесены в таблицу.' : ' Аналитика не загружена — добавьте данные вручную.'}`;

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
  {
    name: 'export_orders_excel',
    description: 'Выгрузить заказы в Excel-таблицу в Редакторе. Используй когда говорят «экспортируй заказы», «скачай список заказов», «выгрузи заказы в Excel». Фильтр по mp или status — опционально.',
    args: '{ mp?: "wb"|"ozon"|"yandex", status?: string, days?: number, title?: string }',
    run: async (a: { mp?: string; status?: string; days?: number; title?: string }) => {
      let orders: any[] = w().allOrdersModule?.orders ?? [];
      if (!orders.length) return 'Заказы не загружены. Перейди в раздел Заказы и повтори.';

      if (a.mp) orders = orders.filter(o => (o.mp ?? o.marketplace ?? '').toLowerCase() === a.mp);
      if (a.status) orders = orders.filter(o => (o.status ?? o.state ?? '').toLowerCase().includes(a.status!.toLowerCase()));
      if (a.days) {
        const cutoff = Date.now() - a.days * 86_400_000;
        orders = orders.filter(o => {
          const d = o.created_at ?? o.date ?? o.in_process_at;
          return d ? new Date(d).getTime() > cutoff : true;
        });
      }

      if (!orders.length) return 'После применения фильтров заказов не найдено.';

      const label = [a.mp?.toUpperCase(), a.status, a.days ? `${a.days} дней` : ''].filter(Boolean).join(', ');
      const title = a.title ?? `Заказы${label ? ' — ' + label : ''} ${new Date().toLocaleDateString('ru-RU')}`;
      return exportOrdersToExcel(orders, title);
    },
  },
];

// ── Actions: экспорт заказов ─────────────────────────────────────────────────────

async function exportOrdersToExcel(orders: any[], title: string): Promise<string> {
  w().app?.navigateTo?.('docs');
  await waitFor(() => !!w().docsModule?.aiCreateDoc, 3000);
  const dm = w().docsModule;
  if (!dm?.aiCreateDoc) return 'Редактор не загрузился. Перейди в раздел «Редактор» вручную и создай Excel там.';

  await dm.aiCreateDoc('excel', title);
  await waitFor(() => !!w().docsModule?.activeDocId, 2000);
  const docId = dm.activeDocId;
  if (!docId) return `Отчёт «${title}» создан. Вставь данные вручную.`;

  const header = ['Дата', 'МП', 'Артикул', 'Статус', 'Сумма'];
  header.forEach((h, col) => dm.aiExcelCommand(docId, 'set_cell', { row: 0, col, value: h }));

  orders.forEach((o, rowIdx) => {
    const date = o.created_at ?? o.date ?? o.in_process_at ?? '';
    const dateStr = date ? new Date(date).toLocaleDateString('ru-RU') : '';
    const mp     = o.mp ?? o.marketplace ?? '';
    const art    = o.article ?? o.offer_id ?? o.nm_id ?? o.market_sku ?? '';
    const status = o.status ?? o.state ?? '';
    const price  = o.price ?? o.amount ?? o.total ?? o.sum ?? '';
    [dateStr, mp, art, status, price].forEach((val, col) =>
      dm.aiExcelCommand(docId, 'set_cell', { row: rowIdx + 1, col, value: val }),
    );
  });

  return `Экспорт завершён: «${title}» — ${orders.length} заказов в таблице (Редактор).`;
}

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

// ── Actions: управление репрайсером ─────────────────────────────────────────────

const REPRICER_MGMT_ACTIONS: AiAction[] = [
  {
    name: 'list_repricer_rules',
    description: 'Показать список всех правил репрайсера с параметрами. Используй когда говорят «покажи правила репрайсера», «какие автоцены настроены», «что в репрайсере».',
    args: '{}',
    run: async () => {
      const rep = w().repricerModule;
      if (!rep) { w().app?.navigateTo?.('repricer'); return 'Открываю Репрайсер. Повтори команду после загрузки.'; }
      const rules: any[] = rep.rules ?? [];
      if (!rules.length) return 'Правил репрайсера нет. Создай первое: выбери товар → «Добавить правило».';
      return `Правила репрайсера (${rules.length}):\n` + rules.map((r: any, i: number) =>
        `${i + 1}. [id:${r.id}] "${r.name ?? '—'}" [${r.mp ?? '—'}] ${r.strategy ?? '—'} мин:${r.min_price ?? '—'}₽ макс:${r.max_price ?? '—'}₽ SKU:${(r.articles ?? []).length}`
      ).join('\n');
    },
  },
  {
    name: 'edit_repricer_rule',
    description: 'Изменить параметры правила репрайсера: мин/макс цену, стратегию. Используй когда говорят «измени мин цену правила X», «поменяй стратегию правила Y». Требует id правила (из list_repricer_rules).',
    args: '{ rule_id: string|number, min_price?: number, max_price?: number, strategy?: "match"|"undercut"|"margin" }',
    run: async (a: { rule_id: string | number; min_price?: number; max_price?: number; strategy?: string }) => {
      const rep = w().repricerModule;
      if (!rep) throw new Error('Репрайсер недоступен — перейди в раздел Репрайсер');
      if (typeof rep.aiEditRule === 'function') return await rep.aiEditRule(a);
      const rules: any[] = rep.rules ?? [];
      const rule = rules.find((r: any) => String(r.id) === String(a.rule_id));
      if (!rule) throw new Error(`Правило id:${a.rule_id} не найдено. Используй list_repricer_rules чтобы увидеть все правила.`);
      const changes: string[] = [];
      if (a.min_price !== undefined) changes.push(`мин. цена: ${a.min_price} ₽`);
      if (a.max_price !== undefined) changes.push(`макс. цена: ${a.max_price} ₽`);
      if (a.strategy) changes.push(`стратегия: ${a.strategy}`);
      if (!changes.length) throw new Error('Укажи что изменить: min_price, max_price или strategy');
      w().app?.navigateTo?.('repricer');
      return `Правило «${rule.name ?? rule.id}»: ${changes.join(', ')}. API прямого редактирования репрайсера пока не подключён — открой правило в разделе Репрайсер и внеси изменения вручную.`;
    },
  },
];

// ── Actions: витрина SimaStore ───────────────────────────────────────────────────

const SIMASTORE_ACTIONS: AiAction[] = [
  {
    name: 'simastore_get_link',
    description: 'Получить публичную ссылку на витрину. Используй когда говорят «ссылка на витрину», «какой URL магазина», «как поделиться витриной».',
    args: '{}',
    run: async () => {
      const sm = w().simaStoreModule ?? w().simastore ?? w().storeModule;
      const slug = sm?.slug ?? sm?.storeSlug ?? sm?.store?.slug ?? '';
      if (!slug) {
        w().app?.navigateTo?.('simastore');
        return 'Slug витрины не найден. Перейди в раздел Витрина → Настройки и задай URL-адрес магазина.';
      }
      const url = `${window.location.origin}/s/${slug}`;
      return `Ссылка на витрину: ${url}\n\nПоделись этой ссылкой с покупателями. Витрина ${(sm?.published ?? sm?.isPublished) ? 'опубликована и доступна' : 'пока не опубликована — нажми «Опубликовать» в настройках витрины'}.`;
    },
  },
  {
    name: 'simastore_publish',
    description: 'Опубликовать или снять с публикации витрину. Используй когда говорят «опубликуй витрину», «запусти магазин», «скрой витрину».',
    args: '{ publish: boolean }',
    run: async (a: { publish: boolean }) => {
      const sm = w().simaStoreModule ?? w().simastore ?? w().storeModule;
      if (!sm) { w().app?.navigateTo?.('simastore'); return 'Открываю раздел Витрина. Повтори команду после загрузки.'; }
      if (typeof sm.aiPublish === 'function') return await sm.aiPublish(a.publish);
      const action = a.publish ? 'опубликовать' : 'снять с публикации';
      w().app?.navigateTo?.('simastore');
      return `Чтобы ${action} витрину — открой раздел Витрина → Настройки → ${a.publish ? '«Опубликовать»' : '«Снять с публикации'}.`;
    },
  },
  {
    name: 'simastore_add_products',
    description: 'Добавить товары из Products Hub на витрину. Используй когда говорят «добавь товары на витрину», «выставь товары в магазин».',
    args: '{ articles?: string[] }',
    run: async (a: { articles?: string[] }) => {
      const sm = w().simaStoreModule ?? w().simastore ?? w().storeModule;
      if (!sm) { w().app?.navigateTo?.('simastore'); return 'Открываю раздел Витрина. Повтори команду после загрузки.'; }
      if (typeof sm.aiAddProducts === 'function') return await sm.aiAddProducts(a.articles);
      const articlesInfo = a.articles?.length ? `Артикулы: ${a.articles.join(', ')}` : 'Все товары из Products Hub';
      w().app?.navigateTo?.('simastore');
      return `${articlesInfo}. Для добавления товаров на витрину: раздел Витрина → «Добавить товары» → выбери из Products Hub.`;
    },
  },
];

// ── Actions: настройки ───────────────────────────────────────────────────────────

const SETTINGS_ACTIONS: AiAction[] = [
  {
    name: 'get_subscription_info',
    description: 'Показать информацию о текущей подписке: тариф, лимиты, дата следующего платежа. Используй когда говорят «какой у меня тариф», «когда следующий платёж», «что входит в подписку».',
    args: '{}',
    run: async () => {
      const stm = w().settingsModule ?? w().subscriptionModule;
      const sub = stm?.subscription ?? stm?.plan ?? w().companyModule?.subscription;
      if (!sub) {
        w().app?.navigateTo?.('settings');
        return 'Информация о подписке недоступна. Открываю Настройки — посмотри раздел «Подписка».';
      }
      const name = sub.name ?? sub.plan ?? sub.tier ?? 'неизвестно';
      const nextPayment = sub.next_payment ?? sub.renewal_date ?? '';
      const price = sub.price ?? sub.amount ?? '';
      let out = `Подписка: ${name}`;
      if (price) out += ` — ${price}₽/мес`;
      if (nextPayment) out += `\nСледующий платёж: ${new Date(nextPayment).toLocaleDateString('ru-RU')}`;
      const limits = sub.limits ?? {};
      if (Object.keys(limits).length) out += `\nЛимиты: ${Object.entries(limits).map(([k, v]) => `${k}: ${v}`).join(', ')}`;
      return out;
    },
  },
  {
    name: 'check_api_keys',
    description: 'Проверить статус API-ключей всех подключённых маркетплейсов и AI-ключа. Используй когда говорят «проверь ключи», «почему не синхронизируется», «статус API».',
    args: '{}',
    run: async () => {
      const results: string[] = [];
      const wbm = w().wbModule;
      if (wbm) results.push(`WB: ${wbm.connected ? '✅ подключён' : '❌ ключ не задан или невалиден'}${wbm.shopName ? ' (' + wbm.shopName + ')' : ''}`);
      else results.push('WB: ⚪ модуль не загружен');
      const ozm = w().ozonModule;
      if (ozm) results.push(`Ozon: ${ozm.connected ? '✅ подключён' : '❌ ключ не задан или невалиден'}${ozm.shopName ? ' (' + ozm.shopName + ')' : ''}`);
      else results.push('Ozon: ⚪ модуль не загружен');
      const ymm = w().yandexModule;
      if (ymm) results.push(`ЯМ: ${ymm.connected ? '✅ подключён' : '❌ ключ не задан или невалиден'}${ymm.shopName ? ' (' + ymm.shopName + ')' : ''}`);
      else results.push('ЯМ: ⚪ модуль не загружен');
      const aiKey = sessionStorage.getItem('sd_ai_key') ?? '';
      results.push(`AI (Сима): ${aiKey ? '✅ ключ настроен' : '❌ ключ не настроен — Настройки → AI → OpenRouter API-ключ'}`);
      return 'Статус API-ключей:\n' + results.join('\n');
    },
  },
  {
    name: 'invite_team_member',
    description: 'Пригласить нового сотрудника в команду по email. Используй когда говорят «добавь сотрудника», «пригласи пользователя», «дай доступ [email]».',
    args: '{ email: string, role?: "admin"|"manager"|"viewer" }',
    run: async (a: { email: string; role?: string }) => {
      if (!a.email) throw new Error('Укажи email сотрудника для приглашения');
      const stm = w().settingsModule;
      if (typeof stm?.aiInviteUser === 'function') return await stm.aiInviteUser(a.email, a.role ?? 'manager');
      w().app?.navigateTo?.('settings');
      return `Для приглашения ${a.email}: Настройки → Команда → «Пригласить пользователя» → введи email${a.role ? ` → роль: ${a.role}` : ''}. После отправки приглашения пользователь получит письмо.`;
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
    'repricer':      [...REPRICER_ACTIONS, ...REPRICER_MGMT_ACTIONS],
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
    'advertising':   ADVERTISING_ACTIONS,
    'simastore':     SIMASTORE_ACTIONS,
    'settings':      SETTINGS_ACTIONS,
    'profile':       SETTINGS_ACTIONS,
  };
  const SUPPLY_ACTIONS: AiAction[] = [
    {
      name: 'list_ym_supply_requests',
      description: 'Показать заявки на поставку Яндекс Маркет FBY (статус, склад, окно приёмки). Используй когда спрашивают "поставки ЯМ", "заявки Яндекса", "что везём на склад Яндекса". ВАЖНО: создать заявку FBY через API невозможно — Маркет разрешает это только в своём кабинете.',
      args: '{}',
      run: async () => {
        const sm = w().supplyModule;
        if (!sm) { w().app?.navigateTo?.('supply'); return 'Открываю раздел Поставки. Повтори команду через секунду.'; }
        return await sm.aiListYmSupplyRequests();
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
// ── Хелперы прямых операций на маркетплейсах ─────────────────────────────────

export type MpKind = 'ozon' | 'wb' | 'yandex';
export const MP_LABEL: Record<MpKind, string> = {
  ozon: 'Ozon', wb: 'Wildberries', yandex: 'Яндекс Маркет',
};

/**
 * Выбрать магазин по подсказке пользователя.
 * Бросает понятную ошибку вместо null: модель читает текст ошибки и сама
 * понимает, что именно переспросить (какой из магазинов имелся в виду).
 */
export function mpResolveStore<T extends { id: string; name: string }>(
  stores: T[], hint: string | undefined, mp: MpKind,
): T {
  const label = MP_LABEL[mp];
  if (!stores.length) throw new Error(`Нет подключённых магазинов ${label}. Подключи их в разделе [Маркетплейсы](/marketplaces).`);
  if (hint && hint.trim()) {
    const h = hint.toLowerCase().trim();
    const exact = stores.filter(s => s.name.toLowerCase() === h);
    if (exact.length === 1) return exact[0];
    const partial = stores.filter(s => s.name.toLowerCase().includes(h));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error(`Под «${hint}» подходит несколько магазинов ${label}: ${partial.map(s => `«${s.name}»`).join(', ')}. Уточни название точнее.`);
    }
    throw new Error(`Магазин «${hint}» не найден среди ${label}. Доступные: ${stores.map(s => `«${s.name}»`).join(', ')}.`);
  }
  if (stores.length === 1) return stores[0];
  throw new Error(`У тебя несколько магазинов ${label}: ${stores.map(s => `«${s.name}»`).join(', ')}. Уточни, в каком выполнить операцию.`);
}

/**
 * Насколько товар подходит под запрос.
 * Точный артикул и точный alt-id (nm_id, market_sku, product_id) — максимум;
 * дальше по убыванию: начало артикула, вхождение, название.
 * Запрос `q` должен быть уже приведён к нижнему регистру.
 */
export function mpMatchScore(q: string, article: string, name: string, altIds: string[]): number {
  const a = (article ?? '').toLowerCase();
  const n = (name ?? '').toLowerCase();
  if (!q) return 0;
  if ((a && a === q) || altIds.some(id => id && id === q)) return 100;
  if (a && a.startsWith(q)) return 70;
  if (a && a.includes(q)) return 50;
  if (n && n === q) return 40;
  if (n && n.includes(q)) return 20;
  return 0;
}

/**
 * Каталоги товаров с коротким кешем.
 *
 * Без него массовая операция на 50 артикулов скачивала весь каталог 50 раз
 * (каждый mp_update_stock искал товар заново). TTL намеренно небольшой:
 * каталог и так отражает состояние на момент последней синхронизации.
 */
const _mpProductsCache: Partial<Record<MpKind, { ts: number; data: any[] }>> = {};
const MP_PRODUCTS_TTL = 30_000;

async function mpProducts(mp: MpKind): Promise<any[]> {
  const hit = _mpProductsCache[mp];
  if (hit && Date.now() - hit.ts < MP_PRODUCTS_TTL) return hit.data;
  let data: any[] = [];
  try {
    if (mp === 'ozon') data = await (await import('@/services/ozonDb')).ozonDb.getProducts();
    else if (mp === 'wb') data = await (await import('@/services/wbDb')).wbDb.getProducts();
    else data = await (await import('@/services/yandexDb')).yandexDb.getProducts();
  } catch { data = []; }
  _mpProductsCache[mp] = { ts: Date.now(), data };
  return data;
}

/**
 * Отразить только что записанное значение в кеше каталога.
 *
 * Запись уходит в API маркетплейса, а локальная строка обновится лишь при
 * следующей синхронизации. Без этого Сима, изменив остаток на 5, при повторном
 * поиске в том же диалоге снова показала бы старое число и запуталась.
 */
function mpPatchCachedProduct(
  mp: MpKind, storeId: string, article: string, patch: { stock?: number; price?: number },
): void {
  const cached = _mpProductsCache[mp];
  if (!cached) return;
  const key = article.toLowerCase();
  for (const p of cached.data) {
    if (p.store_id !== storeId) continue;
    const art = String(mp === 'wb' ? p.vendor_code ?? '' : p.offer_id ?? '').toLowerCase();
    if (art !== key) continue;
    if (patch.stock != null) {
      if (mp === 'ozon') { p.stock_fbs = patch.stock; }
      else { p.stock_total = patch.stock; p.stock_fbs = patch.stock; }
    }
    if (patch.price != null) {
      if (mp === 'ozon') p.price = patch.price;
      else if (mp === 'wb') p.price = patch.price;
      else p.basic_price = patch.price;
    }
    return;
  }
}

/**
 * Остатки напрямую из каталогов МП — работает даже если пользователь ни разу
 * не открывал раздел «Остатки» (модуль тогда пуст).
 * Возвращает null, если каталоги ещё не синхронизированы.
 */
async function countStockFromDb(threshold: number): Promise<{ total: number; oos: number; low: number } | null> {
  try {
    const [oz, wb, ym] = await Promise.all([
      mpProducts('ozon'), mpProducts('wb'), mpProducts('yandex'),
    ]);
    const stocks: number[] = [
      ...oz.map(p => (p.stock_fbs ?? 0) + (p.stock_fbo ?? 0)),
      ...wb.map(p => p.stock_total ?? 0),
      ...ym.filter(p => !p.archived).map(p => p.stock_total ?? 0),
    ];
    if (!stocks.length) return null;
    return {
      total: stocks.length,
      oos: stocks.filter(s => s === 0).length,
      low: stocks.filter(s => s > 0 && s < threshold).length,
    };
  } catch {
    return null;
  }
}

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

  // Откат статуса задачи (mark_task_done возвращал undo, но обработчика не было —
  // «отмени» после закрытия задачи падало с «Нет обработчика отката»).
  registerUndoHandler('task_status', async (p: { id: string; status: string }) => {
    const { taskDb } = await import('@/services/taskDb');
    await taskDb.updateTask(p.id, { status: p.status as any });
    w().taskManagerModule?.load?.();
  });

  // Откат остатка на маркетплейсе — возвращает прежнее значение через тот же API.
  registerUndoHandler('mp_stock', async (p: { mp: string; article: string; stock: number; store?: string }) => {
    await aiPage.run('mp_update_stock', { mp: p.mp, article: p.article, stock: p.stock, store: p.store });
  });

  // Откат цены на маркетплейсе.
  registerUndoHandler('mp_price', async (p: { mp: string; article: string; price: number; store?: string }) => {
    await aiPage.run('mp_update_price', { mp: p.mp, article: p.article, price: p.price, store: p.store });
  });

  const createDoc: AiAction = {
    name: 'create_doc',
    description: 'Создать новый документ в Редакторе (Excel или Word). Работает из любого раздела — сам откроет Редактор.',
    args: '{ type: "excel"|"word", title?: string }',
    run: async (a: { type?: string; title?: string }) => {
      const type = a?.type === 'word' ? 'word' : 'excel';
      await w().app?.navigateTo?.('docs');
      await waitFor(() => !!w().docsModule?.aiCreateDoc, 2000);
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
      const type = a.type ?? 'full';
      const title = a.title ?? `Отчёт SimaDesk ${new Date().toLocaleDateString('ru-RU')}`;

      // For orders-only type, delegate to the full export which writes actual rows
      if (type === 'orders') {
        const orders: any[] = w().allOrdersModule?.orders ?? [];
        if (!orders.length) {
          w().app?.navigateTo?.('orders');
          return 'Заказы не загружены. Открываю раздел Заказы — после загрузки повторите команду.';
        }
        return exportOrdersToExcel(orders, title);
      }

      w().app?.navigateTo?.('docs');
      await waitFor(() => !!w().docsModule?.aiCreateDoc, 2000);
      const dm = w().docsModule;
      if (!dm?.aiCreateDoc) return 'Редактор документов недоступен. Перейдите в раздел «Редактор» и создайте отчёт вручную.';

      await dm.aiCreateDoc('excel', title);
      await new Promise(r => setTimeout(r, 400));

      const lines: string[] = [`Отчёт создан: «${title}»`];
      const docId = dm.activeDocId ?? '';

      // Analytics: пишем KPI-строки в Excel (для type='analytics')
      if (type === 'analytics' && w().analyticsModule?.kpi) {
        const kpi = w().analyticsModule.kpi;
        if (docId) {
          const kpiRows: [string, string | number][] = [
            ['Метрика', 'Значение'],
            ['Выручка нетто', kpi.revenue ?? 0],
            ['Выручка брутто', kpi.revenue_gross ?? 0],
            ['Заказов выполнено', kpi.orders_delivered ?? 0],
            ['В обработке', kpi.orders_processing ?? 0],
            ['Возвраты', kpi.orders_returned ?? 0],
            ['Отмены', kpi.orders_cancelled ?? 0],
            ['Маржа %', Number((kpi.margin_pct ?? 0).toFixed(1))],
            ['Средний чек', kpi.avg_check ?? 0],
            ['Комиссии МП', kpi.commission ?? 0],
            ['Логистика', kpi.logistics ?? 0],
          ];
          for (let i = 0; i < kpiRows.length; i++) {
            dm.aiExcelCommand(docId, 'set_cell', { row: i, col: 0, value: kpiRows[i][0] });
            dm.aiExcelCommand(docId, 'set_cell', { row: i, col: 1, value: kpiRows[i][1] });
          }
          lines.push(`Аналитика: выручка ${kpi.revenue?.toFixed(0)}₽, маржа ${kpi.margin_pct?.toFixed(1)}%, заказов ${(kpi.orders_delivered ?? 0) + (kpi.orders_processing ?? 0)} — данные внесены в таблицу`);
        } else {
          lines.push(`Аналитика: выручка ${kpi.revenue?.toFixed(0)}₽, маржа ${kpi.margin_pct?.toFixed(1)}%`);
        }
      } else if (type === 'full' && w().analyticsModule?.kpi) {
        const kpi = w().analyticsModule.kpi;
        lines.push(`Аналитика: выручка ${kpi.revenue?.toFixed(0)}₽, заказов ${(kpi.orders_delivered ?? 0) + (kpi.orders_processing ?? 0)}, маржа ${kpi.margin_pct?.toFixed(1)}%`);
      }

      // Stock: пишем строки остатков в Excel (для type='stock')
      if (type === 'stock' && w().stockModule?.items?.length) {
        const items = w().stockModule.items;
        const oos = items.filter((i: any) => (i.stockTotal ?? 0) === 0).length;
        if (docId) {
          const header = ['Артикул', 'Название', 'Остаток'];
          header.forEach((h, col) => dm.aiExcelCommand(docId, 'set_cell', { row: 0, col, value: h }));
          items.slice(0, 500).forEach((item: any, rowIdx: number) => {
            [item.vendor_code ?? item.offerId ?? item.article ?? '', item.name ?? '', item.stockTotal ?? 0]
              .forEach((val, col) => dm.aiExcelCommand(docId, 'set_cell', { row: rowIdx + 1, col, value: val }));
          });
          lines.push(`Остатки: ${items.length} SKU, OOS: ${oos} — данные внесены в таблицу`);
        } else {
          lines.push(`Остатки: ${items.length} SKU, OOS: ${oos}`);
        }
      } else if (type === 'full' && w().stockModule?.items?.length) {
        const items = w().stockModule.items;
        const oos = items.filter((i: any) => (i.stockTotal ?? 0) === 0).length;
        lines.push(`Остатки: ${items.length} SKU, OOS: ${oos}`);
      }

      if (type === 'full' && w().allOrdersModule?.orders?.length) {
        const orders: any[] = w().allOrdersModule.orders;
        if (docId) {
          const header = ['Дата', 'МП', 'Артикул', 'Статус', 'Сумма'];
          header.forEach((h, col) => dm.aiExcelCommand(docId, 'set_cell', { row: 0, col, value: h }));
          orders.slice(0, 500).forEach((o: any, rowIdx: number) => {
            const date = o.created_at ?? o.date ?? o.in_process_at ?? '';
            const dateStr = date ? new Date(date).toLocaleDateString('ru-RU') : '';
            [dateStr, o.mp ?? o.marketplace ?? '', o.article ?? o.offer_id ?? o.nm_id ?? '', o.status ?? o.state ?? '', o.price ?? o.amount ?? o.total ?? o.sum ?? '']
              .forEach((val, col) => dm.aiExcelCommand(docId, 'set_cell', { row: rowIdx + 1, col, value: val }));
          });
          lines.push(`Заказы: ${Math.min(orders.length, 500)} записей добавлено в таблицу`);
        } else {
          lines.push(`Заказы: ${orders.length} — данные недоступны (открой Редактор и повтори)`);
        }
      }

      return lines.join('\n');
    },
  });

  // ── Экспорт заказов из любого раздела ──────────────────────────────────────
  aiPage.registerGlobal({
    name: 'export_orders_excel_global',
    description: 'Выгрузить заказы в Excel из любого раздела. Используй когда говорят «экспортируй заказы», «выгрузи заказы в Excel», «сделай список заказов». Работает глобально без перехода в Заказы.',
    args: '{ mp?: "wb"|"ozon"|"yandex", status?: string, days?: number, title?: string }',
    run: async (a: { mp?: string; status?: string; days?: number; title?: string }) => {
      let orders: any[] = w().allOrdersModule?.orders ?? [];
      if (!orders.length) {
        w().app?.navigateTo?.('orders');
        return 'Заказы не загружены. Открываю раздел Заказы — после загрузки повторите команду.';
      }
      if (a.mp) orders = orders.filter((o: any) => (o.mp ?? o.marketplace ?? '').toLowerCase() === a.mp);
      if (a.status) orders = orders.filter((o: any) => (o.status ?? o.state ?? '').toLowerCase().includes(a.status!.toLowerCase()));
      if (a.days) {
        const cutoff = Date.now() - a.days * 86_400_000;
        orders = orders.filter((o: any) => {
          const d = o.created_at ?? o.date ?? o.in_process_at;
          return d ? new Date(d).getTime() > cutoff : true;
        });
      }
      if (!orders.length) return 'После применения фильтров заказов не найдено.';
      const label = [a.mp?.toUpperCase(), a.status, a.days ? `${a.days}д` : ''].filter(Boolean).join(', ');
      const title = a.title ?? `Заказы${label ? ' — ' + label : ''} ${new Date().toLocaleDateString('ru-RU')}`;
      return exportOrdersToExcel(orders, title);
    },
  });

  // ── Полный аудит рисков ─────────────────────────────────────────────────────
  aiPage.registerGlobal({
    name: 'run_risk_audit',
    description: 'Выполнить полный автоматический аудит рисков магазина и создать задачи по найденным проблемам. Используй когда говорят «аудит рисков», «проверь всё», «найди все проблемы».',
    args: '{ create_tasks?: boolean }',
    run: async (a: { create_tasks?: boolean }) => {
      const risks: Array<{ text: string; priority: 'red'|'yellow' }> = [];
      const notLoaded: string[] = [];

      // Остатки. Модуль склада заполнен только если пользователь открывал раздел,
      // поэтому при пустом модуле берём остатки напрямую из каталогов МП —
      // иначе аудит молча рапортовал «рисков нет».
      const items: any[] = w().stockModule?.items ?? [];
      let oosCount = 0, lowCount = 0, stockKnown = false;
      if (items.length) {
        oosCount = items.filter((i: any) => (i.stockTotal ?? 0) === 0).length;
        lowCount = items.filter((i: any) => (i.stockTotal ?? 0) > 0 && (i.stockTotal ?? 0) < 10).length;
        stockKnown = true;
      } else {
        const st = await countStockFromDb(10);
        if (st) { oosCount = st.oos; lowCount = st.low; stockKnown = true; }
      }
      if (stockKnown) {
        if (oosCount) risks.push({ text: `OOS: ${oosCount} товаров без остатков`, priority: 'red' });
        if (lowCount) risks.push({ text: `Критично мало (<10 ед): ${lowCount} товаров`, priority: 'yellow' });
      } else {
        notLoaded.push('остатки');
      }

      // Задачи — тоже с запасным чтением из БД.
      let tasks: any[] = w().taskManagerModule?.tasks ?? [];
      if (!tasks.length) {
        try {
          const { taskDb } = await import('@/services/taskDb');
          tasks = await taskDb.getTasks();
        } catch { notLoaded.push('задачи'); }
      }
      const overdue = tasks.filter((t: any) => t.status !== 'done' && t.due_date && new Date(t.due_date) < new Date());
      if (overdue.length) risks.push({ text: `Просроченных задач: ${overdue.length}`, priority: 'red' });

      // Отзывы
      const reviews: any[] = w().reviewsModule?.allReviews ?? [];
      const badUnans = reviews.filter((r: any) => !r.answered && !r.answer && !r.reply && (r.stars ?? 5) <= 2);
      if (badUnans.length) risks.push({ text: `Негативных отзывов без ответа: ${badUnans.length}`, priority: 'yellow' });
      const allUnans = reviews.filter((r: any) => !r.answered && !r.answer && !r.reply);
      if (allUnans.length > 5) risks.push({ text: `Всего отзывов без ответа: ${allUnans.length}`, priority: 'yellow' });

      // Реклама — убыточные кампании
      const campaigns: any[] = w().advertisingModule?.campaigns ?? [];
      if (!campaigns.length) notLoaded.push('реклама');
      const lossAd = campaigns.filter((c: any) => c.status === 'active' && (c.roi ?? 0) < -20 && (c.spent ?? 0) > 300);
      if (lossAd.length) risks.push({ text: `Убыточных рекламных кампаний (ROI<-20%): ${lossAd.length}`, priority: 'yellow' });

      // Честная оговорка: не выдаём «всё чисто» за разделы, которые не проверяли.
      const caveat = notLoaded.length
        ? `\n\n⚠ Не проверено (данные не загружены): ${notLoaded.join(', ')}. Открой эти разделы для полной картины.`
        : '';

      if (!risks.length) {
        return notLoaded.length
          ? `Аудит завершён — по проверенным разделам критичных рисков нет.${caveat}`
          : 'Аудит завершён — критичных рисков не обнаружено! Магазин работает штатно.';
      }

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

      return `Аудит завершён. Найдено ${risks.length} проблем:\n${risks.map(r => `${r.priority === 'red' ? '🔴' : '🟡'} ${r.text}`).join('\n')}${a.create_tasks !== false ? '\n\nЗадачи созданы в разделе Задачи.' : ''}${caveat}`;
    },
  });

  // ── Ответить на все отзывы без ответа ──────────────────────────────────────
  aiPage.registerGlobal({
    name: 'reply_all_unanswered',
    description: 'Сгенерировать персонализированные AI-ответы и опубликовать на все отзывы без ответа. Если передан template — использует его для всех, иначе генерирует уникальный ответ для каждого отзыва. Используй когда говорят «ответь на все отзывы», «обработай все без ответа».',
    args: '{ template?: string, stars_max?: number, limit?: number }',
    run: async (a: { template?: string; stars_max?: number; limit?: number }) => {
      const rm = w().reviewsModule;
      if (!rm) {
        w().app?.navigateTo?.('reviews');
        return 'Перехожу в раздел Отзывы. После загрузки повторите команду.';
      }
      const reviews: any[] = rm.allReviews ?? [];
      const maxStars = a.stars_max ?? 5;
      const unanswered = reviews.filter((r: any) => !r.answered && !r.answer && !r.reply && (r.stars ?? 5) <= maxStars);
      if (!unanswered.length) return `Отзывов без ответа (≤${maxStars}★) не найдено.`;

      const batch = unanswered.slice(0, a.limit ?? 10);
      const useAi = !a.template;
      const results: string[] = [];
      let replied = 0;

      for (const review of batch) {
        try {
          const text = (review.text ?? review.comment ?? '').toString();
          const stars = review.stars ?? 5;
          const product = (review.productName ?? review.product_name ?? '').toString();

          const replyText = a.template ?? await generateAiReply(text, stars, product);
          await publishReviewReply(rm, review, replyText);
          results.push(`${stars}★ → «${replyText.slice(0, 60)}${replyText.length > 60 ? '…' : ''}»`);
          replied++;
          // Небольшая пауза между запросами к AI
          if (useAi && batch.indexOf(review) < batch.length - 1) await new Promise(r => setTimeout(r, 300));
        } catch (e: any) {
          results.push(`${review.stars ?? '?'}★ — ошибка: ${e?.message ?? 'неизвестно'}`);
        }
      }

      const method = useAi ? 'AI-ответы' : `шаблон: «${a.template!.slice(0, 50)}…»`;
      const more = unanswered.length > batch.length ? ` (из ${unanswered.length} всего)` : '';
      return `Обработано ${replied} отзыв(ов)${more} [${method}]:\n${results.map(r => `• ${r}`).join('\n')}`;
    },
  });

  // ── Дневной чеклист ─────────────────────────────────────────────────────────
  aiPage.registerGlobal({
    name: 'daily_checklist',
    description: 'Сформировать дневной чеклист с приоритетными задачами на сегодня: срочные заказы, негативные отзывы, OOS, убыточные кампании.',
    args: '{}',
    run: async () => {
      const items: Array<{ priority: 'high' | 'medium'; text: string }> = [];

      // Срочные FBS-заказы (дедлайн < 4 ч)
      try {
        const orders: any[] = w().allOrdersModule?.orders ?? [];
        const urgent = orders.filter((o: any) =>
          o.status === 'awaiting_packaging' && o.shipment_date &&
          new Date(o.shipment_date).getTime() - Date.now() < 4 * 3_600_000
        );
        if (urgent.length) items.push({ priority: 'high', text: `⚡ Упаковать ${urgent.length} FBS-заказ(ов) — дедлайн <4ч` });
      } catch { /* ignore */ }

      // Негативные отзывы без ответа
      try {
        const reviews: any[] = w().reviewsModule?.allReviews ?? [];
        const neg = reviews.filter((r: any) => !r.answered && !r.answer && !r.reply && (r.stars ?? 5) <= 2);
        const allUnans = reviews.filter((r: any) => !r.answered && !r.answer && !r.reply);
        if (neg.length) items.push({ priority: 'high', text: `⭐ Ответить на ${neg.length} негативных отзыв(ов) (≤2★)` });
        else if (allUnans.length) items.push({ priority: 'medium', text: `💬 Ответить на ${allUnans.length} отзыв(ов) без ответа` });
      } catch { /* ignore */ }

      // OOS и критично малые остатки
      try {
        const items2: any[] = w().stockModule?.items ?? [];
        const oos = items2.filter((i: any) => (i.stockTotal ?? 0) === 0);
        const low = items2.filter((i: any) => (i.stockTotal ?? 0) > 0 && (i.stockTotal ?? 0) < 10);
        if (oos.length) items.push({ priority: 'high', text: `📦 Пополнить запасы: ${oos.length} SKU с нулевым остатком` });
        if (low.length) items.push({ priority: 'medium', text: `📦 Критично мало (<10 ед): ${low.length} SKU` });
      } catch { /* ignore */ }

      // Убыточные рекламные кампании
      try {
        const campaigns: any[] = w().advertisingModule?.campaigns ?? [];
        const loss = campaigns.filter((c: any) => {
          const spent = c.spent ?? 0;
          const orders = c.orders ?? 0;
          const roi = spent > 0 ? ((orders * 1000 - spent) / spent) * 100 : 0;
          return c.status === 'active' && spent > 0 && roi < -15;
        });
        if (loss.length) items.push({ priority: 'medium', text: `📣 Проверить ${loss.length} убыточных рекламных кампаний (ROI < -15%)` });
      } catch { /* ignore */ }

      // Просроченные задачи
      try {
        const tasks: any[] = w().taskManagerModule?.tasks ?? [];
        const overdue = tasks.filter((t: any) => t.status !== 'done' && t.due_date && new Date(t.due_date) < new Date());
        if (overdue.length) items.push({ priority: 'medium', text: `✅ Просроченных задач: ${overdue.length}` });
      } catch { /* ignore */ }

      if (!items.length) return '✅ Всё под контролем — срочных дел не найдено. Хорошего дня!';

      const high = items.filter(i => i.priority === 'high');
      const medium = items.filter(i => i.priority === 'medium');
      const lines: string[] = ['📋 **Дневной чеклист**\n'];
      if (high.length) {
        lines.push('**🔴 Срочно:**');
        high.forEach(i => lines.push(`• ${i.text}`));
      }
      if (medium.length) {
        if (high.length) lines.push('');
        lines.push('**🟡 Важно:**');
        medium.forEach(i => lines.push(`• ${i.text}`));
      }
      return lines.join('\n');
    },
  });

  // ── Глобальные зеркала page-specific действий ───────────────────────────────
  const replyAllGlobal = REVIEWS_ACTIONS.find(a => a.name === 'reply_all_unanswered');
  if (replyAllGlobal) aiPage.registerGlobal(replyAllGlobal);

  const aiReplyGlobal = REVIEWS_ACTIONS.find(a => a.name === 'ai_generate_review_reply');
  if (aiReplyGlobal) aiPage.registerGlobal(aiReplyGlobal);

  const adStatsGlobal = ADVERTISING_ACTIONS.find(a => a.name === 'get_ad_stats');
  if (adStatsGlobal) aiPage.registerGlobal(adStatsGlobal);

  // ── Новые глобальные actions — задачи ────────────────────────────────────────
  const editTaskGlobal = TASKS_ACTIONS.find(a => a.name === 'edit_task');
  if (editTaskGlobal) aiPage.registerGlobal(editTaskGlobal);

  const deleteTaskGlobal = TASKS_ACTIONS.find(a => a.name === 'delete_task');
  if (deleteTaskGlobal) aiPage.registerGlobal(deleteTaskGlobal);

  // ── Массовое изменение цен по условию ──────────────────────────────────────
  aiPage.registerGlobal({
    name: 'bulk_price_filtered',
    description: 'Изменить цены товаров по условию: только нужный маркетплейс И маржа выше порога. Используй когда говорят «снизь цены на WB с маржой >30%», «скидка 10% на Ozon товарам с маржой выше 20%».',
    args: '{ mp: "wb"|"ozon"|"yandex", delta: number, percent?: boolean, min_margin?: number }',
    run: async (a: { mp: string; delta: number; percent?: boolean; min_margin?: number }) => {
      const pm = w().productsHubModule;
      let items: any[] = pm?.items ?? [];
      if (!items.length) {
        w().app?.navigateTo?.('products-hub');
        await new Promise(r => setTimeout(r, 800));
        items = w().productsHubModule?.items ?? [];
      }
      if (!items.length) return 'Товары не загружены. Откройте раздел Products Hub и повторите команду.';

      const mpItems = items.filter((i: any) => {
        const itemMp = (i.mp ?? i.marketplace ?? '').toLowerCase();
        return itemMp === a.mp.toLowerCase() || itemMp.includes(a.mp.toLowerCase());
      });
      const filtered = a.min_margin != null
        ? mpItems.filter((i: any) => (i.margin_pct ?? i.margin ?? 0) >= a.min_margin!)
        : mpItems;

      if (!filtered.length) {
        const reason = a.min_margin != null ? ` с маржой ≥${a.min_margin}%` : '';
        return `Товаров на ${a.mp.toUpperCase()}${reason} не найдено.`;
      }

      const articles = filtered.map((i: any) => (i.vendor_code ?? i.offer_id ?? i.article ?? i.nm_id ?? '').toString()).filter(Boolean);

      if (typeof pm?.aiApplyPriceDelta === 'function') {
        await pm.aiApplyPriceDelta({ mp: a.mp, delta: a.delta, percent: a.percent ?? false, articles });
        const marginNote = a.min_margin != null ? ` с маржой ≥${a.min_margin}%` : '';
        return `Цены изменены для ${articles.length} товаров на ${a.mp.toUpperCase()}${marginNote}: ${a.percent ? `${a.delta}%` : `${a.delta}₽`}`;
      }

      const marginNote = a.min_margin != null ? ` с маржой ≥${a.min_margin}%` : '';
      return `Найдено ${filtered.length} товаров на ${a.mp.toUpperCase()}${marginNote}. Применение цен через API прямо сейчас недоступно — откройте Products Hub, выделите эти товары и используйте «Изменить цену».`;
    },
  });

  // ── Новые глобальные actions — товары ─────────────────────────────────────────
  const hideProductGlobal = PRODUCTS_HUB_ACTIONS.find(a => a.name === 'hide_product');
  if (hideProductGlobal) aiPage.registerGlobal(hideProductGlobal);

  const showProductGlobal = PRODUCTS_HUB_ACTIONS.find(a => a.name === 'show_product');
  if (showProductGlobal) aiPage.registerGlobal(showProductGlobal);

  const updateDescGlobal = PRODUCTS_HUB_ACTIONS.find(a => a.name === 'update_product_description');
  if (updateDescGlobal) aiPage.registerGlobal(updateDescGlobal);

  // ── Новые глобальные actions — репрайсер ─────────────────────────────────────
  for (const act of REPRICER_MGMT_ACTIONS) aiPage.registerGlobal(act);

  // ── Новые глобальные actions — витрина ─────────────────────────────────────
  for (const act of SIMASTORE_ACTIONS) aiPage.registerGlobal(act);

  // ── Новые глобальные actions — настройки ─────────────────────────────────────
  for (const act of SETTINGS_ACTIONS) aiPage.registerGlobal(act);

  // ── Отзывы: загрузить и описать с любой страницы ────────────────────────────
  aiPage.registerGlobal({
    name: 'fetch_reviews',
    description: 'Перейти в раздел Отзывов, загрузить отзывы для нужного маркетплейса и вернуть сводку. Используй когда пользователь спрашивает про отзывы, просит посмотреть отзывы за сегодня/неделю, или спрашивает про конкретный МП. Сам перейдёт в раздел.',
    args: '{ mp?: "wb"|"ozon"|"yandex", date?: "today"|"week" }',
    run: async (a: { mp?: string; date?: string }) => {
      const rm = w().reviewsModule;
      if (!rm) throw new Error('Модуль отзывов недоступен');
      await w().app?.navigateTo?.('reviews');
      if (!rm.hasLoadedAny) await rm.show?.();
      const mp = (a?.mp === 'wb' || a?.mp === 'ozon' || a?.mp === 'yandex') ? a.mp : undefined;
      const date = (a?.date === 'today' || a?.date === 'week') ? a.date : undefined;
      return rm.fetchAndDescribe(mp, date);
    },
  });

  // ── Маркетплейсы: живые операции — поиск, остатки, цены, аудит ───────────────

  /** Единый вид найденного товара, независимо от маркетплейса. */
  interface MpHit {
    mp: MpKind;
    storeId: string;
    storeName: string;
    article: string;      // то, чем пользователь оперирует (offer_id / vendor_code)
    name: string;
    price: number | null;
    stock: number | null;
    nmId?: number;        // WB
    score: number;
  }

  /** Магазины всех МП с коротким кешем — они меняются редко, а запрашиваются часто. */
  let _mpStoresCache: { ts: number; data: { ozon: any[]; wb: any[]; yandex: any[] } } | null = null;
  async function mpLoadAllStores(force = false) {
    if (!force && _mpStoresCache && Date.now() - _mpStoresCache.ts < 60_000) return _mpStoresCache.data;
    const [{ ozonDb }, { wbDb }, { yandexDb }] = await Promise.all([
      import('@/services/ozonDb'),
      import('@/services/wbDb'),
      import('@/services/yandexDb'),
    ]);
    const [ozon, wb, yandex] = await Promise.all([
      ozonDb.getStores().catch(() => []),
      wbDb.getStores().catch(() => []),
      yandexDb.getStores().catch(() => []),
    ]);
    const data = { ozon, wb, yandex };
    _mpStoresCache = { ts: Date.now(), data };
    return data;
  }

  /**
   * Найти товар во всех (или указанных) магазинах.
   * Каталог каждого МП грузится ОДИН раз, а не по разу на магазин.
   */
  async function mpFindHits(query: string, mp?: string, storeHint?: string, limit = 12): Promise<MpHit[]> {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) throw new Error('Укажи артикул или название товара');
    const stores = await mpLoadAllStores();
    const hint = storeHint?.toLowerCase().trim();
    const want = (k: MpKind) => !mp || mp === k;
    const hits: MpHit[] = [];

    const pick = <T extends { id: string; name: string }>(list: T[]) =>
      hint ? list.filter(s => s.name.toLowerCase().includes(hint)) : list;

    if (want('ozon') && stores.ozon.length) {
      const target = pick(stores.ozon);
      if (target.length) {
        const products = await mpProducts('ozon');
        for (const store of target) {
          for (const p of products) {
            if (p.store_id !== store.id) continue;
            const score = mpMatchScore(q, p.offer_id, p.name, [String(p.product_id ?? ''), String(p.sku ?? '')]);
            if (score > 0) hits.push({
              mp: 'ozon', storeId: store.id, storeName: store.name,
              article: p.offer_id, name: p.name, price: p.price ?? null,
              stock: (p.stock_fbs ?? 0) + (p.stock_fbo ?? 0), score,
            });
          }
        }
      }
    }

    if (want('wb') && stores.wb.length) {
      const target = pick(stores.wb);
      if (target.length) {
        const products = await mpProducts('wb');
        for (const store of target) {
          for (const p of products) {
            if (p.store_id !== store.id) continue;
            const score = mpMatchScore(q, p.vendor_code ?? '', p.title ?? '', [String(p.nm_id ?? '')]);
            if (score > 0) hits.push({
              mp: 'wb', storeId: store.id, storeName: store.name,
              article: p.vendor_code, name: p.title, price: p.price ?? null,
              stock: p.stock_total ?? p.stock_fbs ?? null, nmId: p.nm_id, score,
            });
          }
        }
      }
    }

    if (want('yandex') && stores.yandex.length) {
      const target = pick(stores.yandex);
      if (target.length) {
        const products = await mpProducts('yandex');
        for (const store of target) {
          for (const p of products) {
            if (p.store_id !== store.id) continue;
            const score = mpMatchScore(q, p.offer_id, p.name, [String(p.market_sku ?? ''), (p.vendor_code ?? '').toLowerCase()]);
            if (score > 0) hits.push({
              mp: 'yandex', storeId: store.id, storeName: store.name,
              article: p.offer_id, name: p.name,
              price: p.basic_price ?? p.offer_price ?? null,
              stock: p.stock_total ?? null, score,
            });
          }
        }
      }
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  const fmtHit = (h: MpHit) =>
    `${MP_LABEL[h.mp]} «${h.storeName}»: [${h.article}]${h.nmId ? ` (nm_id ${h.nmId})` : ''} «${String(h.name).slice(0, 55)}» — ` +
    `${h.price != null ? h.price + '₽' : 'цена —'}, остаток ${h.stock ?? '—'} шт`;

  /** Ровно один товар для операции записи: иначе — понятная ошибка модели. */
  async function mpResolveOneHit(article: string, mp: MpKind, storeHint?: string): Promise<MpHit> {
    // Сначала проверяем сам магазин: если подсказка неверна, ошибка должна быть
    // про магазин («такого магазина нет, есть вот эти»), а не про товар.
    if (storeHint) {
      const all = await mpLoadAllStores();
      mpResolveStore(all[mp], storeHint, mp);
    }
    const hits = await mpFindHits(article, mp, storeHint, 20);
    if (!hits.length) {
      throw new Error(`Товар «${article}» не найден в ${MP_LABEL[mp]}${storeHint ? ` (магазин «${storeHint}»)` : ''}. Проверь артикул через mp_find_product.`);
    }
    const best = hits[0];
    const ties = hits.filter(h => h.score === best.score);
    if (ties.length > 1) {
      throw new Error(`Под «${article}» в ${MP_LABEL[mp]} подходит несколько товаров:\n${ties.map(h => '• ' + fmtHit(h)).join('\n')}\nУточни точный артикул или магазин.`);
    }
    return best;
  }

  /**
   * Список складов магазина с коротким кешем.
   * Массовое обновление на 50 позиций иначе делало 50 одинаковых запросов
   * к API маркетплейса и рисковало упереться в лимит (429).
   */
  const _whCache = new Map<string, { ts: number; data: any[] }>();
  async function mpWarehouses(storeId: string, load: () => Promise<any[]>): Promise<any[]> {
    const hit = _whCache.get(storeId);
    if (hit && Date.now() - hit.ts < 60_000) return hit.data;
    const data = await load();
    _whCache.set(storeId, { ts: Date.now(), data });
    return data;
  }

  /** Склад для FBS-операции + предупреждение, если складов несколько. */
  function pickWarehouse<T extends { name?: string }>(list: T[], mp: MpKind): { wh: T; note: string } {
    if (!list.length) throw new Error(`FBS-склады ${MP_LABEL[mp]} не найдены. Настрой FBS-склад в личном кабинете ${MP_LABEL[mp]}.`);
    const note = list.length > 1
      ? ` ⚠ У магазина ${list.length} складов — использован «${(list[0] as any).name ?? '—'}».`
      : '';
    return { wh: list[0], note };
  }

  aiPage.registerGlobal({
    name: 'mp_get_stores',
    description: 'Получить список всех подключённых магазинов по маркетплейсам. Используй когда нужно узнать какие магазины есть у пользователя или перед выбором магазина для операции.',
    args: '{}',
    run: async () => {
      const { ozon, wb, yandex } = await mpLoadAllStores(true);
      const lines: string[] = [];
      if (ozon.length) lines.push(`Ozon (${ozon.length}): ${ozon.map(s => `«${s.name}»`).join(', ')}`);
      if (wb.length) lines.push(`Wildberries (${wb.length}): ${wb.map(s => `«${s.name}»`).join(', ')}`);
      if (yandex.length) lines.push(`Яндекс Маркет (${yandex.length}): ${yandex.map(s => `«${s.name}»`).join(', ')}`);
      if (!lines.length) return 'Подключённых магазинов не найдено. Добавь их в разделе [Маркетплейсы](/marketplaces).';
      return `Подключённые магазины:\n${lines.join('\n')}`;
    },
  });

  aiPage.registerGlobal({
    name: 'mp_find_product',
    description: 'Найти товар по артикулу (offer_id / vendor_code / nm_id / market_sku) или части названия во всех подключённых магазинах всех маркетплейсов. Используй ПЕРЕД изменением остатка или цены, чтобы узнать текущие значения и в каком магазине лежит товар.',
    args: '{ query: string, mp?: "wb"|"ozon"|"yandex", store?: string }',
    run: async (a: { query: string; mp?: string; store?: string }) => {
      const hits = await mpFindHits(a.query, a.mp, a.store);
      if (!hits.length) {
        return `Товар «${a.query}» не найден ни в одном магазине${a.mp ? ` на ${MP_LABEL[a.mp as MpKind] ?? a.mp}` : ''}. Проверь артикул или убери фильтр по маркетплейсу.`;
      }
      return `Найдено ${hits.length}:\n${hits.map(h => '• ' + fmtHit(h)).join('\n')}`;
    },
  });

  aiPage.registerGlobal({
    name: 'mp_update_stock',
    description: 'Изменить FBS-остаток товара на маркетплейсе через живой API. Используй когда просят «уменьши остаток», «поставь остаток 5 для артикула X», «обнули склад». Действие можно откатить командой «отмени».',
    args: '{ article: string, stock: number, mp: "wb"|"ozon"|"yandex", store?: string }',
    run: async (a: { article: string; stock: number; mp: string; store?: string }) => {
      if (!a.article) throw new Error('Укажи артикул товара');
      const stock = Number(a.stock);
      if (!Number.isFinite(stock) || stock < 0) throw new Error('Укажи новый остаток — целое число от 0');
      if (!['wb', 'ozon', 'yandex'].includes(a.mp)) throw new Error('Укажи маркетплейс: wb, ozon или yandex');
      const mp = a.mp as MpKind;

      const stores = await mpLoadAllStores();
      const hit = await mpResolveOneHit(a.article, mp, a.store);
      const prevStock = hit.stock;
      let note = '';

      if (mp === 'ozon') {
        const store = stores.ozon.find(s => s.id === hit.storeId)!;
        const { updateOzonFbsStock, ozonApi: ozApi } = await import('@/services/ozonApi');
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const picked = pickWarehouse(await mpWarehouses(store.id, () => ozApi.getWarehouses(creds)), mp);
        note = picked.note;
        const res = await updateOzonFbsStock(store, [{ offer_id: hit.article, stock, warehouse_id: (picked.wh as any).warehouse_id }]);
        const failed = res.find(r => !r.updated);
        if (failed) throw new Error(`Ozon отклонил обновление [${hit.article}]: ${failed.errors?.join('; ') || 'причина не указана'}`);

      } else if (mp === 'wb') {
        const store = stores.wb.find(s => s.id === hit.storeId)!;
        const { wbApi: wbMod } = await import('@/services/wbApi');
        const picked = pickWarehouse(await mpWarehouses(store.id, () => wbMod.getWarehouses(store.api_key)), mp);
        note = picked.note;
        if (!hit.nmId) throw new Error(`nm_id для «${hit.article}» не найден — синхронизируй товары WB`);
        const barcodes = await wbMod.getCardBarcodes(store.api_key, hit.nmId);
        if (!barcodes.length) throw new Error(`Баркод для nm_id ${hit.nmId} не найден — заполни баркод в карточке WB`);
        await wbMod.updateFbsStocks(store.api_key, (picked.wh as any).id, [{ sku: barcodes[0], amount: stock }]);

      } else {
        const store = stores.yandex.find(s => s.id === hit.storeId)!;
        if (!store.campaign_id) throw new Error(`Магазин ЯМ «${hit.storeName}» не настроен: нет campaign_id`);
        const { updateYandexFbsStock, fetchYandexFbsWarehousesFromStocks } = await import('@/services/yandexApi');
        const whs = await mpWarehouses(store.id, () => fetchYandexFbsWarehousesFromStocks(store));
        const picked = pickWarehouse(whs, mp);
        note = picked.note;
        await updateYandexFbsStock(store, [{ offerId: hit.article, warehouseId: (picked.wh as any).warehouseId, count: stock }]);
      }

      mpPatchCachedProduct(mp, hit.storeId, hit.article, { stock });

      const summary = `✅ ${MP_LABEL[mp]} «${hit.storeName}» · [${hit.article}] «${String(hit.name).slice(0, 45)}»\n` +
        `Остаток: ${prevStock ?? '—'} → ${stock} шт${note}`;

      return prevStock != null
        ? { summary, undo: { kind: 'mp_stock', payload: { mp, article: hit.article, stock: prevStock, store: hit.storeName }, label: `Остаток ${hit.article} → ${prevStock} шт` } }
        : summary;
    },
  });

  aiPage.registerGlobal({
    name: 'mp_update_price',
    description: 'Изменить цену товара на маркетплейсе через живой API. Используй когда просят «поставь цену X для артикула Y», «подними цену на Ozon». Действие можно откатить командой «отмени».',
    args: '{ article: string, price: number, mp: "wb"|"ozon"|"yandex", store?: string }',
    run: async (a: { article: string; price: number; mp: string; store?: string }) => {
      if (!a.article) throw new Error('Укажи артикул товара');
      const price = Number(a.price);
      if (!Number.isFinite(price) || price <= 0) throw new Error('Укажи корректную цену — положительное число');
      if (!['wb', 'ozon', 'yandex'].includes(a.mp)) throw new Error('Укажи маркетплейс: wb, ozon или yandex');
      const mp = a.mp as MpKind;

      const stores = await mpLoadAllStores();
      const hit = await mpResolveOneHit(a.article, mp, a.store);
      const prevPrice = hit.price;

      // Защита от опечатки: цена в 5+ раз меньше текущей — почти всегда ошибка ввода.
      if (prevPrice && price < prevPrice / 5) {
        throw new Error(`Новая цена ${price}₽ более чем в 5 раз ниже текущей (${prevPrice}₽) для «${hit.article}». Если это не опечатка — подтверди у пользователя и повтори.`);
      }

      if (mp === 'ozon') {
        const store = stores.ozon.find(s => s.id === hit.storeId)!;
        const { ozonApi: ozMod } = await import('@/services/ozonApi');
        await ozMod.updatePrices({ client_id: store.client_id, api_key: store.api_key }, [{ offer_id: hit.article, price: String(price) }]);

      } else if (mp === 'wb') {
        const store = stores.wb.find(s => s.id === hit.storeId)!;
        const { updateWbPrices } = await import('@/services/wbApi');
        if (!hit.nmId) throw new Error(`nm_id для «${hit.article}» не найден — синхронизируй товары WB`);
        await updateWbPrices(store.api_key, [{ nmID: hit.nmId, price }]);

      } else {
        const store = stores.yandex.find(s => s.id === hit.storeId)!;
        if (!store.campaign_id) throw new Error(`Магазин ЯМ «${hit.storeName}» не настроен: нет campaign_id`);
        const { yandexApi: ymMod } = await import('@/services/yandexApi');
        await ymMod.updateOfferPrices(store.api_key, String(store.campaign_id), [{ offerId: hit.article, price }]);
      }

      mpPatchCachedProduct(mp, hit.storeId, hit.article, { price });

      const summary = `✅ ${MP_LABEL[mp]} «${hit.storeName}» · [${hit.article}] «${String(hit.name).slice(0, 45)}»\n` +
        `Цена: ${prevPrice ?? '—'}₽ → ${price}₽`;

      return prevPrice != null
        ? { summary, undo: { kind: 'mp_price', payload: { mp, article: hit.article, price: prevPrice, store: hit.storeName }, label: `Цена ${hit.article} → ${prevPrice}₽` } }
        : summary;
    },
  });

  aiPage.registerGlobal({
    name: 'mp_bulk_update_stock',
    description: 'Изменить остатки СРАЗУ У НЕСКОЛЬКИХ товаров на одном маркетплейсе. Используй когда просят «обнули остатки у этих артикулов», «поставь по 10 штук на список товаров». items — массив {article, stock}.',
    args: '{ mp: "wb"|"ozon"|"yandex", items: [{ article: string, stock: number }], store?: string }',
    run: async (a: { mp: string; items: Array<{ article: string; stock: number }>; store?: string }) => {
      if (!['wb', 'ozon', 'yandex'].includes(a.mp)) throw new Error('Укажи маркетплейс: wb, ozon или yandex');
      const items = Array.isArray(a.items) ? a.items : [];
      if (!items.length) throw new Error('Передай список товаров items: [{article, stock}]');
      if (items.length > 50) throw new Error(`Слишком много позиций за раз (${items.length}). Максимум 50 — разбей на части.`);

      const ok: string[] = [];
      const failed: string[] = [];
      for (const it of items) {
        try {
          const res = await aiPage.run('mp_update_stock', { mp: a.mp, article: it.article, stock: it.stock, store: a.store });
          ok.push(res.summary.replace(/^✅\s*/, '').replace(/\n/g, ' · '));
        } catch (e) {
          failed.push(`[${it.article}] ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const parts = [`Обновлено ${ok.length} из ${items.length} позиций на ${MP_LABEL[a.mp as MpKind]}.`];
      if (ok.length) parts.push('\n✅ Успешно:\n' + ok.map(s => '• ' + s).join('\n'));
      if (failed.length) parts.push('\n❌ Не удалось:\n' + failed.map(s => '• ' + s).join('\n'));
      return parts.join('\n');
    },
  });

  aiPage.registerGlobal({
    name: 'mp_compare_prices',
    description: 'Сравнить цену и остаток одного товара во ВСЕХ маркетплейсах и магазинах сразу. Используй когда спрашивают «где этот товар дороже», «сравни цены по площадкам», «одинаковая ли цена везде».',
    args: '{ article: string }',
    run: async (a: { article: string }) => {
      const hits = await mpFindHits(a.article, undefined, undefined, 30);
      if (!hits.length) return `Товар «${a.article}» не найден ни на одной площадке.`;
      const priced = hits.filter(h => h.price != null);
      const lines = hits.map(h => '• ' + fmtHit(h));
      let out = `Товар «${a.article}» — найден в ${hits.length} местах:\n${lines.join('\n')}`;
      if (priced.length > 1) {
        const min = priced.reduce((m, h) => (h.price! < m.price! ? h : m));
        const max = priced.reduce((m, h) => (h.price! > m.price! ? h : m));
        const spread = max.price! - min.price!;
        const spreadPct = min.price! > 0 ? (spread / min.price! * 100) : 0;
        out += `\n\nДешевле всего: ${MP_LABEL[min.mp]} «${min.storeName}» — ${min.price}₽`;
        out += `\nДороже всего: ${MP_LABEL[max.mp]} «${max.storeName}» — ${max.price}₽`;
        out += `\nРазброс: ${spread.toFixed(0)}₽ (${spreadPct.toFixed(0)}%)`;
        if (spreadPct > 15) out += `\n⚠ Разброс больше 15% — стоит выровнять цены, иначе площадка с высокой ценой почти не продаёт.`;
      }
      const oos = hits.filter(h => (h.stock ?? 0) === 0);
      if (oos.length) out += `\n\n🚫 Нет в наличии: ${oos.map(h => `${MP_LABEL[h.mp]} «${h.storeName}»`).join(', ')}`;
      return out;
    },
  });

  aiPage.registerGlobal({
    name: 'mp_stock_health',
    description: 'Аудит остатков по ВСЕМ магазинам всех маркетплейсов: что закончилось (OOS) и что заканчивается. Используй когда спрашивают «что заканчивается», «где нули по остаткам», «что срочно пополнить», «проверь склады».',
    args: '{ threshold?: number, mp?: "wb"|"ozon"|"yandex" }',
    run: async (a: { threshold?: number; mp?: string }) => {
      const threshold = Number.isFinite(Number(a.threshold)) ? Number(a.threshold) : 10;
      const stores = await mpLoadAllStores();
      const rows: Array<{ mp: MpKind; store: string; article: string; name: string; stock: number }> = [];
      const want = (k: MpKind) => !a.mp || a.mp === k;

      if (want('ozon') && stores.ozon.length) {
        const products = await mpProducts('ozon');
        const byId = new Map(stores.ozon.map(s => [s.id, s.name]));
        for (const p of products) {
          const st = byId.get(p.store_id); if (!st) continue;
          rows.push({ mp: 'ozon', store: st, article: p.offer_id, name: p.name, stock: (p.stock_fbs ?? 0) + (p.stock_fbo ?? 0) });
        }
      }
      if (want('wb') && stores.wb.length) {
        const products = await mpProducts('wb');
        const byId = new Map(stores.wb.map(s => [s.id, s.name]));
        for (const p of products) {
          const st = byId.get(p.store_id); if (!st) continue;
          rows.push({ mp: 'wb', store: st, article: p.vendor_code, name: p.title, stock: p.stock_total ?? 0 });
        }
      }
      if (want('yandex') && stores.yandex.length) {
        const products = await mpProducts('yandex');
        const byId = new Map(stores.yandex.map(s => [s.id, s.name]));
        for (const p of products) {
          const st = byId.get(p.store_id); if (!st) continue;
          if (p.archived) continue;
          rows.push({ mp: 'yandex', store: st, article: p.offer_id, name: p.name, stock: p.stock_total ?? 0 });
        }
      }

      if (!rows.length) return 'Товары не загружены. Синхронизируй маркетплейсы в разделе [Маркетплейсы](/marketplaces) и повтори.';

      const oos = rows.filter(r => r.stock === 0);
      const low = rows.filter(r => r.stock > 0 && r.stock < threshold);
      const fmtRow = (r: typeof rows[number]) => `• ${MP_LABEL[r.mp]} «${r.store}» [${r.article}] «${String(r.name).slice(0, 40)}» — ${r.stock} шт`;

      // Разбивка по магазинам — менеджеру важно понимать, где именно дыра.
      const byStore: Record<string, number> = {};
      for (const r of oos) { const k = `${MP_LABEL[r.mp]} «${r.store}»`; byStore[k] = (byStore[k] ?? 0) + 1; }

      let out = `Аудит остатков: всего ${rows.length} SKU · закончилось ${oos.length} · меньше ${threshold} шт — ${low.length}.`;
      if (Object.keys(byStore).length) {
        out += `\n\nOOS по магазинам: ${Object.entries(byStore).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} — ${v}`).join(', ')}`;
      }
      if (oos.length) out += `\n\n🚫 Закончились (до 15):\n${oos.slice(0, 15).map(fmtRow).join('\n')}`;
      if (low.length) out += `\n\n📉 Заканчиваются (до 15):\n${low.slice(0, 15).map(fmtRow).join('\n')}`;
      if (!oos.length && !low.length) out += `\n\n✅ Критичных позиций нет — остатки в норме.`;
      return out;
    },
  });


  aiPage.registerGlobal({
    name: 'business_snapshot',
    description: 'Единая управленческая сводка по всему бизнесу: магазины, остатки по всем МП, задачи, отзывы, реклама, аналитика. Используй когда просят «как дела с бизнесом», «дай сводку», «что происходит», «отчёт по магазину», «с чего начать сегодня». Заменяет несколько отдельных запросов — вызывай ЕЁ, а не 5 действий подряд.',
    args: '{}',
    run: async () => {
      const blocks: string[] = [];
      const gaps: string[] = [];

      // 1. Магазины — фундамент: без них остальное не имеет смысла.
      try {
        const { ozon, wb, yandex } = await mpLoadAllStores(true);
        const parts: string[] = [];
        if (ozon.length) parts.push(`Ozon — ${ozon.map(s => `«${s.name}»`).join(', ')}`);
        if (wb.length) parts.push(`WB — ${wb.map(s => `«${s.name}»`).join(', ')}`);
        if (yandex.length) parts.push(`ЯМ — ${yandex.map(s => `«${s.name}»`).join(', ')}`);
        blocks.push(parts.length
          ? `🏪 МАГАЗИНЫ (${ozon.length + wb.length + yandex.length}): ${parts.join(' | ')}`
          : '🏪 МАГАЗИНЫ: не подключено ни одного — начни с раздела [Маркетплейсы](/marketplaces).');
      } catch { gaps.push('магазины'); }

      // 2. Остатки — из БД, независимо от открытых разделов.
      const st = await countStockFromDb(10);
      if (st) {
        const risk = st.oos > 0 ? ` 🔴 требует внимания` : st.low > 0 ? ` 🟡` : ' ✅';
        blocks.push(`📦 ОСТАТКИ: ${st.total} SKU · закончилось ${st.oos} · меньше 10 шт — ${st.low}${risk}`);
      } else {
        gaps.push('остатки (каталоги не синхронизированы)');
      }

      // 3. Задачи.
      try {
        const { taskDb } = await import('@/services/taskDb');
        const tasks = await taskDb.getTasks();
        const open = tasks.filter((t: any) => t.status !== 'done');
        const overdue = open.filter((t: any) => t.due_date && new Date(t.due_date) < new Date());
        blocks.push(`✅ ЗАДАЧИ: открытых ${open.length}${overdue.length ? ` · просрочено ${overdue.length} 🔴` : ''}`
          + (overdue.length ? `\n   Просроченные: ${overdue.slice(0, 3).map((t: any) => `«${t.title}»`).join(', ')}` : ''));
      } catch { gaps.push('задачи'); }

      // 4. Отзывы и 5. Реклама — только из загруженных модулей (API дорогое).
      const reviews: any[] = w().reviewsModule?.allReviews ?? [];
      if (reviews.length) {
        const unans = reviews.filter((r: any) => !r.answered && !r.answer && !r.reply);
        const neg = unans.filter((r: any) => (r.stars ?? r.rating ?? 5) <= 2);
        blocks.push(`⭐ ОТЗЫВЫ: всего ${reviews.length} · без ответа ${unans.length}${neg.length ? ` · негативных ${neg.length} 🔴` : ''}`);
      } else gaps.push('отзывы');

      const campaigns: any[] = w().advertisingModule?.campaigns ?? [];
      if (campaigns.length) {
        const active = campaigns.filter((c: any) => c.status === 'active');
        const spent = campaigns.reduce((s: number, c: any) => s + (c.spent ?? 0), 0);
        const loss = active.filter((c: any) => (c.roi ?? 0) < -15 && (c.spent ?? 0) > 200);
        blocks.push(`📣 РЕКЛАМА: кампаний ${campaigns.length} (активных ${active.length}) · расход ${fmtRub(spent)}`
          + (loss.length ? `\n   🔴 Убыточных: ${loss.map((c: any) => `«${c.name}» ROI ${c.roi?.toFixed(0)}%`).join(', ')}` : ''));
      } else gaps.push('реклама');

      // 6. Аналитика — из уже загруженного модуля.
      const kpi = w().analyticsModule?.kpi;
      if (kpi) {
        blocks.push(`📈 АНАЛИТИКА: выручка ${fmtRub(kpi.revenue ?? 0)} · маржа ${kpi.margin_pct?.toFixed?.(1) ?? '—'}% · заказов ${(kpi.orders_delivered ?? 0) + (kpi.orders_processing ?? 0)}`);
      } else gaps.push('аналитика');

      let out = `СВОДКА ПО БИЗНЕСУ — ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}\n\n${blocks.join('\n\n')}`;
      if (gaps.length) {
        out += `\n\n⚠ Нет данных по: ${gaps.join(', ')}. Это НЕ значит «всё хорошо» — данные просто не загружены.`;
        out += `\n(Аналитику можно догрузить действием fetch_analytics, отзывы — fetch_reviews.)`;
      }
      return out;
    },
  });

  // ── Аналитика: загрузить данные с любой страницы ─────────────────────────────
  aiPage.registerGlobal({
    name: 'fetch_analytics',
    description: 'Перейти в раздел Аналитики, загрузить данные и вернуть полный отчёт. Используй ВСЕГДА когда пользователь спрашивает про аналитику, выручку, заказы, маржу, топ товаров, прибыль. Аргумент mp: "ozon"|"wb"|"yandex" — ОБЯЗАТЕЛЬНО передавай если пользователь упоминает конкретный маркетплейс (Яндекс/ЯМ → "yandex", WB/Wildberries → "wb", Озон → "ozon"). После получения данных отвечай ТОЛЬКО текстом анализа — не запускай других действий и не переходи в другие разделы.',
    args: '{"mp":"ozon"}',
    run: async (args: { mp?: string } = {}) => {
      const am = w().analyticsModule;
      if (!am) throw new Error('Модуль аналитики недоступен');
      const raw = String(args.mp ?? '').toLowerCase();
      const mp = (raw === 'yandex' || raw === 'ym' || raw === 'yandex_market' || raw === 'ям') ? 'yandex'
               : (raw === 'wb' || raw === 'wildberries') ? 'wb'
               : (raw === 'ozon' || raw === 'озон') ? 'ozon'
               : null;

      // Переходим в Аналитику и ждём загрузки данных
      await w().app?.navigateTo?.('analytics');
      if (!am.isDataLoaded) {
        await am.show();
        await waitFor(() => !!(w().analyticsModule?.isDataLoaded), 15000);
      }
      // Переключение МП обязано ДОЖДАТЬСЯ перезагрузки, иначе вернём чужие данные
      if (mp) {
        if (am.selectMpAndReload) {
          await am.selectMpAndReload(mp);
        } else {
          am.selectMp?.(mp);
          await waitFor(() => !!(w().analyticsModule?.isDataLoaded), 15000);
        }
      }

      const actualMp: string = am.selectedMp ?? '';
      if (mp && actualMp && actualMp !== mp) {
        return `Не удалось переключиться на ${MP_NAME[mp]} — возможно этот маркетплейс не подключён. Данные показаны по ${MP_NAME[actualMp] ?? actualMp}.`;
      }
      const summary: string = am.getAiSummary?.() ?? '';
      if (!summary) return 'Данные аналитики загружены, но пока пусты — возможно нет подключённых маркетплейсов или данных за период.';
      const label = MP_NAME[actualMp] ?? 'вашего магазина';
      return `Вот актуальные данные аналитики — ${label} (за выбранный период):\n\n${summary}`;
    },
  });
}
