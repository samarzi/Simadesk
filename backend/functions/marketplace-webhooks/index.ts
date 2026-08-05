/**
 * Marketplace Webhooks Handler
 * Принимает webhook-события от маркетплейсов и уведомляет пользователей
 */

export interface Env {
  // KV для хранения подписок
  WEBHOOK_SUBSCRIPTIONS: KVNamespace;
  // DO для WebSocket соединений
  WEBSOCKET_MANAGER: DurableObjectNamespace;
}

interface WebhookEvent {
  marketplace: 'ozon' | 'wb' | 'yandex';
  type: string;
  timestamp: string;
  data: any;
}

/**
 * Главный обработчик webhook-запросов
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Ozon Webhooks
      if (path.startsWith('/webhooks/ozon')) {
        return await handleOzonWebhook(request, env, corsHeaders);
      }

      // Wildberries Webhooks
      if (path.startsWith('/webhooks/wb')) {
        return await handleWbWebhook(request, env, corsHeaders);
      }

      // Yandex Webhooks
      if (path.startsWith('/webhooks/yandex')) {
        return await handleYandexWebhook(request, env, corsHeaders);
      }

      // WebSocket endpoint для real-time уведомлений
      if (path === '/ws') {
        return await handleWebSocket(request, env);
      }

      // API для регистрации webhooks
      if (path === '/api/webhooks/register' && request.method === 'POST') {
        return await registerWebhook(request, env, corsHeaders);
      }

      // API для получения истории событий
      if (path === '/api/webhooks/events' && request.method === 'GET') {
        return await getWebhookEvents(request, env, corsHeaders);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (err) {
      console.error('[Webhook Error]', err);
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
  },
};

/**
 * Обработчик webhook-событий Ozon
 */
async function handleOzonWebhook(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.json() as any;

  // Валидация подписи Ozon (если настроена)
  // const signature = request.headers.get('X-Ozon-Signature');
  // if (!verifyOzonSignature(body, signature)) {
  //   return new Response('Invalid signature', { status: 403 });
  // }

  const event: WebhookEvent = {
    marketplace: 'ozon',
    type: body.message_type ?? 'unknown',
    timestamp: new Date().toISOString(),
    data: body,
  };

  // Сохранить событие
  await saveEvent(env, event);

  // Обработать событие
  await processEvent(env, event);

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Обработчик webhook-событий Wildberries
 */
async function handleWbWebhook(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.json() as any;

  const event: WebhookEvent = {
    marketplace: 'wb',
    type: body.type ?? 'unknown',
    timestamp: new Date().toISOString(),
    data: body,
  };

  await saveEvent(env, event);
  await processEvent(env, event);

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Обработчик webhook-событий Яндекс.Маркет
 */
async function handleYandexWebhook(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.json() as any;

  const event: WebhookEvent = {
    marketplace: 'yandex',
    type: body.eventType ?? 'unknown',
    timestamp: new Date().toISOString(),
    data: body,
  };

  await saveEvent(env, event);
  await processEvent(env, event);

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Обработать webhook-событие
 */
async function processEvent(env: Env, event: WebhookEvent): Promise<void> {
  console.log('[Webhook Event]', event.marketplace, event.type);

  // Примеры обработки событий
  switch (event.type) {
    case 'order.created':
    case 'NEW_ORDER':
      await notifyNewOrder(env, event);
      break;

    case 'message.new':
    case 'NEW_MESSAGE':
      await notifyNewMessage(env, event);
      break;

    case 'order.status_changed':
    case 'ORDER_STATUS_CHANGED':
      await notifyOrderStatusChanged(env, event);
      break;

    case 'return.created':
    case 'NEW_RETURN':
      await notifyNewReturn(env, event);
      break;

    default:
      console.log('[Webhook] Unknown event type:', event.type);
  }
}

/**
 * Уведомить о новом заказе
 */
async function notifyNewOrder(env: Env, event: WebhookEvent): Promise<void> {
  const notification = {
    type: 'NEW_ORDER',
    marketplace: event.marketplace,
    title: '🛍️ Новый заказ',
    message: `Получен новый заказ на ${event.marketplace}`,
    data: event.data,
    timestamp: event.timestamp,
  };

  await broadcastNotification(env, notification);
}

/**
 * Уведомить о новом сообщении
 */
async function notifyNewMessage(env: Env, event: WebhookEvent): Promise<void> {
  const notification = {
    type: 'NEW_MESSAGE',
    marketplace: event.marketplace,
    title: '💬 Новое сообщение',
    message: `Получено новое сообщение от покупателя на ${event.marketplace}`,
    data: event.data,
    timestamp: event.timestamp,
  };

  await broadcastNotification(env, notification);
}

/**
 * Уведомить об изменении статуса заказа
 */
async function notifyOrderStatusChanged(env: Env, event: WebhookEvent): Promise<void> {
  const notification = {
    type: 'ORDER_STATUS_CHANGED',
    marketplace: event.marketplace,
    title: '📦 Изменение статуса',
    message: `Статус заказа изменён на ${event.marketplace}`,
    data: event.data,
    timestamp: event.timestamp,
  };

  await broadcastNotification(env, notification);
}

/**
 * Уведомить о новом возврате
 */
async function notifyNewReturn(env: Env, event: WebhookEvent): Promise<void> {
  const notification = {
    type: 'NEW_RETURN',
    marketplace: event.marketplace,
    title: '🔄 Новый возврат',
    message: `Создан новый возврат на ${event.marketplace}`,
    data: event.data,
    timestamp: event.timestamp,
  };

  await broadcastNotification(env, notification);
}

/**
 * Отправить уведомление всем подключённым клиентам
 */
async function broadcastNotification(env: Env, notification: any): Promise<void> {
  // TODO: Implement WebSocket broadcast via Durable Objects
  console.log('[Broadcast]', notification);
}

/**
 * Сохранить событие в KV
 */
async function saveEvent(env: Env, event: WebhookEvent): Promise<void> {
  const key = `event:${event.marketplace}:${Date.now()}`;
  await env.WEBHOOK_SUBSCRIPTIONS.put(key, JSON.stringify(event), {
    expirationTtl: 7 * 24 * 60 * 60, // 7 дней
  });
}

/**
 * WebSocket handler для real-time уведомлений
 */
async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  // TODO: Implement WebSocket via Durable Objects
  return new Response('WebSocket not yet implemented', { status: 501 });
}

/**
 * API для регистрации webhook
 */
async function registerWebhook(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.json() as any;
  const { marketplace, events, url } = body;

  if (!marketplace || !events || !url) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Сохранить регистрацию
  const key = `subscription:${marketplace}:${Date.now()}`;
  await env.WEBHOOK_SUBSCRIPTIONS.put(key, JSON.stringify({ marketplace, events, url }));

  return new Response(
    JSON.stringify({ success: true, subscriptionId: key }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

/**
 * API для получения истории событий
 */
async function getWebhookEvents(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const url = new URL(request.url);
  const marketplace = url.searchParams.get('marketplace');
  const limit = Number(url.searchParams.get('limit')) || 100;

  // TODO: Implement pagination and filtering
  const events: any[] = [];

  return new Response(
    JSON.stringify({ events }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}
