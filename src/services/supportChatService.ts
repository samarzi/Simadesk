import { dbFetch } from '@/services/dbClient';

export interface SupportMessage {
  id: string;
  sender_role: 'user' | 'admin';
  content: string;
  attachments: SupportAttachment[];
  created_at: string;
}

export interface SupportAttachment {
  name: string;
  kind: 'image' | 'text';
  data: string;   // base64 dataURL for images, text content for docs
  size: number;
}

export interface SupportChat {
  id: string;
  reason: string;
  status: 'open' | 'closed';
  created_at: string;
  messages: SupportMessage[];
}

export interface AdminSupportChat {
  id: string;
  reason: string;
  status: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
  first_name: string;
  last_name: string | null;
  telegram_username: string | null;
  company_name: string | null;
  last_message: string | null;
  last_message_role: string | null;
  last_message_at: string | null;
  unread_count: number;
  messages?: SupportMessage[];
}

/** Ответ support_poll — всё состояние чата за один запрос. */
export interface SupportPoll {
  status: 'open' | 'closed';
  peer_typing: boolean;
  messages: SupportMessage[];
}

export const SUPPORT_REASONS: Record<string, string> = {
  question:       '❓ Вопрос',
  problem:        '🚨 Проблема',
  billing:        '💳 Оплата / тариф',
  recommendation: '💡 Предложение',
  feature:        '🔧 Запрос функции',
  other:          '💬 Другое',
};

/** Человекочитаемый текст ошибки RPC вместо «HTTP 400 (…): {"code":…}». */
export function supportErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // PostgREST кладёт текст RAISE EXCEPTION в поле message JSON-ответа
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  const msg = m ? m[1] : raw;
  if (/does not exist|не существует/i.test(msg)) {
    return 'Чат поддержки не настроен в базе — примените миграцию 20260730_support_chat_fix.sql';
  }
  if (/HTTP 401/.test(raw)) return 'Сессия истекла — войдите заново';
  return msg.slice(0, 200);
}

class SupportChatService {
  /** Последняя ошибка любого вызова — для отображения в UI. */
  lastError: string | null = null;

  private fail(scope: string, e: unknown): void {
    this.lastError = supportErrorText(e);
    console.error(`[Support] ${scope}:`, e);
  }

  /** Диагностика: права, количество чатов и сообщений в базе. */
  async debugStatus(): Promise<Record<string, unknown> | null> {
    try {
      return await dbFetch<Record<string, unknown>>('/rpc/support_debug_status', {
        method: 'POST', body: '{}',
      });
    } catch (e) { this.fail('debugStatus', e); return null; }
  }

  async createChat(reason: string): Promise<string> {
    // Returns jsonb string (UUID) — PostgREST returns scalar jsonb as the raw value
    const res = await dbFetch<string>('/rpc/create_support_chat', {
      method: 'POST',
      body: JSON.stringify({ p_reason: reason }),
    });
    // Handle both direct string and possible array wrapping by PostgREST versions
    if (Array.isArray(res)) return String(Object.values(res[0] ?? {})[0] ?? res[0]);
    return res!;
  }

  /**
   * Активный чат текущего пользователя.
   * `undefined` — запрос не удался (сеть/права), `null` — чата действительно нет.
   * Это различие критично: раньше любая ошибка выглядела как «оператор закрыл диалог».
   */
  async getMyChat(): Promise<SupportChat | null | undefined> {
    try {
      const res = await dbFetch<SupportChat | null>('/rpc/get_my_support_chat', {
        method: 'POST', body: '{}',
      });
      this.lastError = null;
      return res ?? null;
    } catch (e) { this.fail('getMyChat', e); return undefined; }
  }

  async sendMessage(chatId: string, content: string, attachments: SupportAttachment[] = []): Promise<void> {
    await dbFetch('/rpc/send_support_message', {
      method: 'POST',
      body: JSON.stringify({ p_chat_id: chatId, p_content: content, p_attachments: attachments }),
    });
    this.lastError = null;
  }

  /**
   * Один запрос вместо трёх: новые сообщения + статус чата + печатает ли
   * собеседник. `null` — запрос не прошёл (сеть/права), вызывающий не должен
   * трактовать это как «чат закрыт».
   */
  async poll(chatId: string, after: string | null = null): Promise<SupportPoll | null> {
    try {
      const res = await dbFetch<SupportPoll>('/rpc/support_poll', {
        method: 'POST',
        body: JSON.stringify({ p_chat_id: chatId, p_after: after }),
      });
      this.lastError = null;
      if (!res) return null;
      return {
        status: res.status ?? 'open',
        peer_typing: !!res.peer_typing,
        messages: res.messages ?? [],
      };
    } catch (e) { this.fail('poll', e); return null; }
  }

  /** Отметить «я печатаю». Роль определяет сервер по auth.uid(). */
  async setTyping(chatId: string): Promise<void> {
    try {
      await dbFetch('/rpc/support_set_typing', {
        method: 'POST', body: JSON.stringify({ p_chat_id: chatId }),
      });
    } catch { /* индикатор набора — не повод показывать ошибку */ }
  }

  async clearTyping(chatId: string): Promise<void> {
    try {
      await dbFetch('/rpc/support_clear_typing', {
        method: 'POST', body: JSON.stringify({ p_chat_id: chatId }),
      });
    } catch { /* см. выше */ }
  }

  async getMessagesSince(chatId: string, after: string | null = null): Promise<SupportMessage[]> {
    try {
      const res = await dbFetch<SupportMessage[]>('/rpc/get_support_messages_since', {
        method: 'POST',
        body: JSON.stringify({ p_chat_id: chatId, p_after: after }),
      });
      this.lastError = null;
      return res ?? [];
    } catch (e) { this.fail('getMessagesSince', e); return []; }
  }

  async closeMyChat(chatId: string): Promise<void> {
    await dbFetch('/rpc/close_my_support_chat', {
      method: 'POST',
      body: JSON.stringify({ p_chat_id: chatId }),
    });
  }

  // Admin
  /**
   * Список чатов для админки.
   * Бросает исключение — админка обязана показать причину, а не пустой список:
   * молчаливый `catch → []` и был причиной «сообщения не приходят».
   */
  async adminGetChats(status = 'open'): Promise<AdminSupportChat[]> {
    const res = await dbFetch<AdminSupportChat[]>('/rpc/admin_get_support_chats', {
      method: 'POST',
      body: JSON.stringify({ p_status: status }),
    });
    this.lastError = null;
    return res ?? [];
  }

  async adminGetChat(chatId: string): Promise<AdminSupportChat | null> {
    try {
      const res = await dbFetch<AdminSupportChat>('/rpc/admin_get_support_chat', {
        method: 'POST',
        body: JSON.stringify({ p_chat_id: chatId }),
      });
      this.lastError = null;
      return res ?? null;
    } catch (e) { this.fail('adminGetChat', e); return null; }
  }

  async adminSendMessage(chatId: string, content: string, attachments: SupportAttachment[] = []): Promise<void> {
    await dbFetch('/rpc/admin_send_support_message', {
      method: 'POST',
      body: JSON.stringify({ p_chat_id: chatId, p_content: content, p_attachments: attachments }),
    });
  }

  async adminCloseChat(chatId: string): Promise<void> {
    await dbFetch('/rpc/admin_close_support_chat', {
      method: 'POST',
      body: JSON.stringify({ p_chat_id: chatId }),
    });
  }

  fmtTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}

export const supportChatService = new SupportChatService();
