/**
 * Политика выполнения действий ассистента.
 *
 * Отвечает на один вопрос: можно ли выполнить действие молча или нужно сперва
 * спросить пользователя.
 *
 * Раньше это решала сама модель — выбирала формат ответа (page_action против
 * page_action_plan). На вопрос «какие товары закончились?» она вызвала
 * create_oos_tasks и создала два десятка задач без спроса. Инструкции в промте
 * такое не удерживают, поэтому правило вынесено в код и проверяется в точке
 * запуска — обойти его нельзя ни форматом ответа, ни шагом цепочки.
 */

/**
 * Действия, МАССОВО меняющие данные пользователя: создают пачку задач, правят
 * цены или остатки скопом, публикуют наружу, удаляют безвозвратно.
 *
 * Точечные изменения сюда НЕ входят: пользователь называет конкретный артикул
 * или задачу, объём предсказуем, а результат обратим через «отмени».
 */
/**
 * Точечные изменения: перед выполнением показываем «было → станет» и просим
 * подтвердить. Только когда пользователь явно просит (agentSteps === 0).
 * В середине агент-цепочки пропускаем — иначе каждый шаг прерывается.
 */
export const PREVIEW_REQUIRED_ACTIONS = new Set<string>([
  'mp_update_stock', 'mp_update_price',
]);

export const CONFIRM_REQUIRED_ACTIONS = new Set<string>([
  // массовое создание задач
  'create_oos_tasks', 'create_daily_brief', 'create_urgent_orders_task',
  'create_low_stock_tasks', 'create_reorder_tasks', 'run_risk_audit',
  // массовое изменение цен и остатков
  'bulk_price_change', 'bulk_price_filtered', 'apply_price_delta', 'mp_bulk_update_stock',
  // массовые ответы и публикации
  'reply_all_unanswered', 'simastore_publish', 'simastore_add_products',
  // необратимое и внешнее
  'delete_task', 'invite_team_member', 'create_ym_supply', 'create_supply_wb',
]);

export function needsConfirmation(name: string): boolean {
  return CONFIRM_REQUIRED_ACTIONS.has(name);
}

/**
 * Человеческое описание того, что произойдёт — текст карточки подтверждения.
 * Пользователь должен понять последствия, не читая код.
 */
export function describePendingAction(name: string, args: any, actionLabel?: string): string {
  const a = args ?? {};
  const mp = String(a.mp ?? '—').toUpperCase();
  const amount = a.percent ? `${a.delta}%` : `${a.delta} ₽`;
  switch (name) {
    case 'create_oos_tasks':
      return 'Создам задачи по товарам, которых нет в наличии — по одной сводной задаче на маркетплейс, со списком позиций внутри.';
    case 'run_risk_audit':
      return 'Проведу аудит рисков и создам задачи по найденным проблемам.';
    case 'create_daily_brief':
      return 'Создам задачи по итогам утренней проверки: OOS, просрочки, отзывы без ответа.';
    case 'create_urgent_orders_task':
      return 'Создам задачу по заказам, которые ждут обработки.';
    case 'bulk_price_change':
      return `Изменю цены ВСЕХ товаров на ${mp} на ${amount}.`;
    case 'bulk_price_filtered':
      return `Изменю цены товаров на ${mp}${a.min_margin != null ? ` с маржой не ниже ${a.min_margin}%` : ''} на ${amount}.`;
    case 'apply_price_delta':
      return `Изменю цены выделенных товаров на ${mp} на ${amount}.`;
    case 'mp_bulk_update_stock':
      return `Изменю остатки у ${Array.isArray(a.items) ? a.items.length : '—'} товаров на ${mp}.`;
    case 'reply_all_unanswered':
      return 'Сгенерирую и опубликую AI-ответы на все отзывы без ответа.';
    case 'delete_task':
      return `Удалю задачу «${a.title ?? '—'}». Отменить это будет нельзя.`;
    case 'simastore_publish':
      return a.publish === false
        ? 'Сниму витрину с публикации — она перестанет быть доступна покупателям.'
        : 'Опубликую витрину — она станет доступна покупателям.';
    case 'simastore_add_products':
      return 'Добавлю товары на витрину.';
    case 'invite_team_member':
      return `Отправлю приглашение в команду на ${a.email ?? '—'}.`;
    case 'create_ym_supply':
      return `Создам отгрузку на Яндекс Маркет${a.date ? ` на ${a.date}` : ''}.`;
    case 'create_supply_wb':
      return 'Создам поставку Wildberries из текущих заказов.';
    default:
      return `Выполню действие «${actionLabel ?? name}».`;
  }
}
