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

export const SUPPORT_REASONS: Record<string, string> = {
  question:       '❓ Вопрос',
  problem:        '🚨 Проблема',
  billing:        '💳 Оплата / тариф',
  recommendation: '💡 Предложение',
  feature:        '🔧 Запрос функции',
  other:          '💬 Другое',
};

class SupportChatService {
  async createChat(reason: string): Promise<string> {
    const res = await dbFetch<string>('/rpc/create_support_chat', {
      method: 'POST',
      body: JSON.stringify({ p_reason: reason }),
    });
    return res!;
  }

  async getMyChat(): Promise<SupportChat | null> {
    try {
      const res = await dbFetch<SupportChat | null>('/rpc/get_my_support_chat', {
        method: 'POST', body: '{}',
      });
      return res ?? null;
    } catch { return null; }
  }

  async sendMessage(chatId: string, content: string, attachments: SupportAttachment[] = []): Promise<void> {
    await dbFetch('/rpc/send_support_message', {
      method: 'POST',
      body: JSON.stringify({ p_chat_id: chatId, p_content: content, p_attachments: attachments }),
    });
  }

  async getMessagesSince(chatId: string, after: string | null = null): Promise<SupportMessage[]> {
    try {
      const res = await dbFetch<SupportMessage[]>('/rpc/get_support_messages_since', {
        method: 'POST',
        body: JSON.stringify({ p_chat_id: chatId, p_after: after }),
      });
      return res ?? [];
    } catch { return []; }
  }

  async closeMyChat(chatId: string): Promise<void> {
    await dbFetch('/rpc/close_my_support_chat', {
      method: 'POST',
      body: JSON.stringify({ p_chat_id: chatId }),
    });
  }

  // Admin
  async adminGetChats(status = 'open'): Promise<AdminSupportChat[]> {
    try {
      const res = await dbFetch<AdminSupportChat[]>('/rpc/admin_get_support_chats', {
        method: 'POST',
        body: JSON.stringify({ p_status: status }),
      });
      return res ?? [];
    } catch { return []; }
  }

  async adminGetChat(chatId: string): Promise<AdminSupportChat | null> {
    try {
      const res = await dbFetch<AdminSupportChat>('/rpc/admin_get_support_chat', {
        method: 'POST',
        body: JSON.stringify({ p_chat_id: chatId }),
      });
      return res ?? null;
    } catch { return null; }
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
