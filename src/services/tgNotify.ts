/**
 * tgNotify — отправка Telegram-уведомлений пользователям SimaDesk.
 *
 * Вызывается из фронтенда при наступлении событий (новый заказ,
 * низкий остаток, плохой отзыв). Запрос идёт напрямую в Telegram Bot API
 * через edge function /functions/v1/telegram-bot/notify.
 */

import { dbFetch } from './dbClient';

interface NotifyPayload {
  event: 'new_order' | 'low_stock' | 'bad_review';
  company_id: string;
  data: Record<string, unknown>;
}

/**
 * Отправить событие в edge function для доставки в Telegram.
 * Edge function ищет привязанные чаты и шлёт сообщения.
 * Ошибки проглатываются — уведомления не должны ломать основной флоу.
 */
export async function tgNotify(event: NotifyPayload['event'], companyId: string, data: Record<string, unknown>): Promise<void> {
  try {
    await dbFetch('rpc/tg_send_notification', {
      method: 'POST',
      body: JSON.stringify({ p_event: event, p_company_id: companyId, p_data: data }),
    });
  } catch {
    // Notifications are best-effort — never block the caller
  }
}

/**
 * Quick helper: send a Telegram notification for a new order.
 */
export async function notifyNewOrder(companyId: string, order: { id: string; product: string; marketplace: string; amount: number }): Promise<void> {
  await tgNotify('new_order', companyId, order);
}

/**
 * Quick helper: send a Telegram notification for low stock.
 */
export async function notifyLowStock(companyId: string, product: { name: string; stock: number; marketplace: string }): Promise<void> {
  await tgNotify('low_stock', companyId, product);
}

/**
 * Quick helper: send a Telegram notification for a bad review.
 */
export async function notifyBadReview(companyId: string, review: { author: string; rating: number; text: string; marketplace: string; product: string }): Promise<void> {
  await tgNotify('bad_review', companyId, review);
}
