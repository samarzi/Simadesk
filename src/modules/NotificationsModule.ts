/**
 * NotificationsModule — настройки Telegram-уведомлений.
 *
 * Позволяет пользователю:
 *  - Привязать Telegram чат (через ссылку на бота)
 *  - Включить/выключить типы уведомлений
 *  - Настроить порог низкого остатка
 */

import { debug } from '@/utils/debug';
import { I } from '@/utils/icons';
import { dbFetch } from '@/services/dbClient';
import { companyService } from '@/services/companyService';
import { authService } from '@/services/authService';
import { helpBtn } from '@/services/helpModal';

interface TgChat {
  id: string;
  chat_id: number;
  company_id: string;
}

interface NotificationSettings {
  id: string;
  user_id: string;
  company_id: string;
  notify_new_order: boolean;
  notify_low_stock: boolean;
  notify_bad_review: boolean;
  notify_daily_summary: boolean;
  low_stock_threshold: number;
}

const BOT_USERNAME = (import.meta as any).env?.VITE_TG_BOT_USERNAME ?? 'simadesk_bot';

export class NotificationsModule {
  private container: HTMLElement;
  private chat: TgChat | null = null;
  private settings: NotificationSettings | null = null;
  private loading = false;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    await this.loadData();
    this.render();
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  private async loadData(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const companyId = companyService.getActiveId();
      if (!companyId) return;

      const userId = authService.getUser()?.id;
      if (!userId) return;

      // Load chat
      const chats = await dbFetch<TgChat[]>(`tg_chats?user_id=eq.${userId}&company_id=eq.${companyId}&select=*`);
      this.chat = chats?.[0] ?? null;

      // Load settings
      const settings = await dbFetch<NotificationSettings[]>(
        `tg_notification_settings?user_id=eq.${userId}&company_id=eq.${companyId}&select=*`,
      );
      this.settings = settings?.[0] ?? null;

      // Create default settings if none exist
      if (!this.settings && companyId) {
        const created = await dbFetch<NotificationSettings[]>('tg_notification_settings', {
          method: 'POST',
          body: JSON.stringify({
            user_id: userId,
            company_id: companyId,
            notify_new_order: true,
            notify_low_stock: true,
            notify_bad_review: true,
            notify_daily_summary: false,
            low_stock_threshold: 5,
          }),
        });
        this.settings = created?.[0] ?? null;
      }
    } catch (e) {
      debug.warn('[NotificationsModule] load error:', e);
    }
    this.loading = false;
  }

  async updateSetting(key: string, value: boolean | number): Promise<void> {
    if (!this.settings) return;
    try {
      await dbFetch(`tg_notification_settings?id=eq.${this.settings.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [key]: value, updated_at: new Date().toISOString() }),
      });
      (this.settings as any)[key] = value;
      this.render();
    } catch (e) {
      debug.warn('[NotificationsModule] update error:', e);
    }
  }

  async unlinkChat(): Promise<void> {
    if (!this.chat) return;
    try {
      await dbFetch(`tg_chats?id=eq.${this.chat.id}`, { method: 'DELETE' });
      this.chat = null;
      this.render();
      try { window.app?.toast?.('Telegram чат отвязан', 'success'); } catch (e) { debug.warn('[NotificationsModule] swallowed error', e); }
    } catch (e) {
      debug.warn('[NotificationsModule] unlink error:', e);
    }
  }

  render(): void {
    const s = this.settings;
    const isLinked = !!this.chat;

    const toggle = (key: string, value: boolean) => `
      <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;flex-shrink:0">
        <input type="checkbox" ${value ? 'checked' : ''} style="opacity:0;width:0;height:0"
          onchange="window.notificationsModule.updateSetting('${key}', this.checked)">
        <span style="position:absolute;inset:0;border-radius:12px;transition:.2s;
          background:${value ? '#16a34a' : '#94a3b8'}"></span>
        <span style="position:absolute;top:3px;left:${value ? '23px' : '3px'};
          width:18px;height:18px;border-radius:50%;background:#fff;
          transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></span>
      </label>`;

    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none">
                <path d="M22 2L11 13" stroke="#229ED9" stroke-width="2" stroke-linecap="round"/>
                <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="#229ED9" stroke-width="2" stroke-linejoin="round"/>
              </svg>
              <span class="oz-brand-name">Telegram Уведомления</span>
            </div>
          </div>
          <div class="oz-topbar-right">
            ${helpBtn('notifications')}
          </div>
        </div>

        <div style="flex:1;overflow:auto;padding:24px;max-width:640px">

          <!-- Bot status card -->
          <div style="background:${isLinked ? '#f0fdf4' : 'var(--bg-2)'};border:2px solid ${isLinked ? '#16a34a40' : 'var(--border)'};border-radius:14px;padding:20px;margin-bottom:20px">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
              <div style="width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,#229ED9,#0088cc);
                display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff">
                  <path d="M22 2L11 13M22 2L15 22L11 13L2 9L22 2Z"/>
                </svg>
              </div>
              <div style="flex:1">
                <div style="font-size:16px;font-weight:700;color:${isLinked ? '#16a34a' : 'var(--text)'}">
                  ${isLinked ? '✓ Бот подключён' : 'Бот не подключён'}
                </div>
                <div style="font-size:13px;color:var(--text-2);margin-top:2px">
                  ${isLinked
                    ? `Chat ID: ${this.chat!.chat_id}`
                    : 'Нажмите кнопку ниже, чтобы подключить уведомления'}
                </div>
              </div>
            </div>

            ${isLinked ? `
              <div style="display:flex;gap:8px">
                <a href="https://t.me/${BOT_USERNAME}" target="_blank"
                  style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;
                    background:#229ED9;color:#fff;text-decoration:none;font-size:13px;font-weight:600">
                  ${I.externalLink('', 14)} Открыть бота
                </a>
                <button onclick="window.notificationsModule.unlinkChat()"
                  style="padding:8px 16px;border-radius:8px;border:1px solid #dc262640;
                    background:#dc262610;color:#dc2626;cursor:pointer;font-size:13px;font-weight:600">
                  Отвязать чат
                </button>
              </div>
            ` : `
              <a href="https://t.me/${BOT_USERNAME}?start=link" target="_blank"
                style="display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:10px;
                  background:#229ED9;color:#fff;text-decoration:none;font-size:14px;font-weight:700">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff">
                  <path d="M22 2L11 13M22 2L15 22L11 13L2 9L22 2Z"/>
                </svg>
                Подключить Telegram бота
              </a>
            `}
          </div>

          <!-- Notification settings -->
          ${s ? `
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;overflow:hidden">

              <div style="padding:16px 20px;border-bottom:1px solid var(--border);
                display:flex;align-items:center;justify-content:space-between">
                <div style="font-size:14px;font-weight:700;color:var(--text)">
                  ${I.messageCircle('', 16)} Типы уведомлений
                </div>
              </div>

              <!-- New order -->
              <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
                <div style="flex:1">
                  <div style="font-size:13px;font-weight:600;color:var(--text)">📦 Новые заказы</div>
                  <div style="font-size:12px;color:var(--text-2);margin-top:2px">Уведомление при каждом новом заказе FBS</div>
                </div>
                ${toggle('notify_new_order', s.notify_new_order)}
              </div>

              <!-- Low stock -->
              <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
                <div style="flex:1">
                  <div style="font-size:13px;font-weight:600;color:var(--text)">⚠️ Низкие остатки</div>
                  <div style="font-size:12px;color:var(--text-2);margin-top:2px">Когда остаток товара падает ниже порога</div>
                </div>
                ${toggle('notify_low_stock', s.notify_low_stock)}
              </div>

              <!-- Low stock threshold -->
              ${s.notify_low_stock ? `
                <div style="padding:12px 20px 12px 44px;border-bottom:1px solid var(--border);
                  display:flex;align-items:center;gap:10px">
                  <span style="font-size:12px;color:var(--text-2)">Порог:</span>
                  <input type="number" min="1" max="100" value="${s.low_stock_threshold}"
                    onchange="window.notificationsModule.updateSetting('low_stock_threshold', parseInt(this.value) || 5)"
                    style="width:60px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;
                      background:var(--bg);color:var(--text);font-size:13px;text-align:center">
                  <span style="font-size:12px;color:var(--text-2)">шт.</span>
                </div>
              ` : ''}

              <!-- Bad review -->
              <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
                <div style="flex:1">
                  <div style="font-size:13px;font-weight:600;color:var(--text)">⭐ Плохие отзывы</div>
                  <div style="font-size:12px;color:var(--text-2);margin-top:2px">Уведомление при отзыве 1-2★</div>
                </div>
                ${toggle('notify_bad_review', s.notify_bad_review)}
              </div>

              <!-- Daily summary -->
              <div style="padding:14px 20px;display:flex;align-items:center;gap:12px">
                <div style="flex:1">
                  <div style="font-size:13px;font-weight:600;color:var(--text)">📊 Ежедневная сводка</div>
                  <div style="font-size:12px;color:var(--text-2);margin-top:2px">Итоги дня в 21:00</div>
                </div>
                ${toggle('notify_daily_summary', s.notify_daily_summary)}
              </div>

            </div>
          ` : `
            <div style="text-align:center;padding:40px;color:var(--text-2)">
              ${this.loading ? 'Загрузка…' : 'Настройки недоступны'}
            </div>
          `}

          <!-- How it works -->
          <div style="margin-top:20px;padding:16px 20px;background:var(--bg-2);border-radius:12px;
            font-size:12px;color:var(--text-2);line-height:1.7">
            <div style="font-weight:700;color:var(--text);margin-bottom:6px">Как это работает</div>
            1. Подключите бота через кнопку выше<br>
            2. В Telegram выполните <code>/start</code><br>
            3. Настройте типы уведомлений выше<br>
            4. Бот начнёт отправлять уведомления при наступлении событий
          </div>

        </div>
      </div>
    `;
  }
}
