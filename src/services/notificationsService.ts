/**
 * Сервис уведомлений пользователей.
 * Уведомления хранятся в user_notifications (PostgREST).
 * user_id = NULL → broadcast всем пользователям.
 */

import { dbFetch, REST_URL, getAuthHeaders } from './dbClient';

export type NotifType = 'info' | 'success' | 'warning' | 'error' | 'token_gift' | 'store_alert' | 'system';

export interface UserNotification {
  id: string;
  user_id: string | null;
  type: NotifType;
  title: string;
  body: string | null;
  icon: string;
  read: boolean;
  created_at: string;
  metadata: Record<string, unknown>;
  sender_id: string | null;
}

export interface SendNotifPayload {
  user_id?: string | null;   // null or omit → broadcast
  type: NotifType;
  title: string;
  body?: string;
  icon?: string;
  metadata?: Record<string, unknown>;
}

// ── Пользовательские операции ────────────────────────────────────────────────

export async function fetchMyNotifications(): Promise<UserNotification[]> {
  const res = await fetch(
    `${REST_URL}/user_notifications?select=*&order=created_at.desc&limit=60`,
    { headers: getAuthHeaders() },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<UserNotification[]>;
}

export async function countUnreadNotifications(): Promise<number> {
  const res = await fetch(
    `${REST_URL}/user_notifications?read=eq.false&limit=0`,
    { headers: { ...getAuthHeaders(), 'Prefer': 'count=exact' } },
  );
  if (!res.ok) return 0;
  const cr = res.headers.get('content-range')?.split('/')[1];
  return parseInt(cr ?? '0', 10) || 0;
}

export async function markNotifRead(id: string): Promise<void> {
  await dbFetch(`user_notifications?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ read: true }),
  });
}

export async function markAllNotifsRead(): Promise<void> {
  await dbFetch('user_notifications?read=eq.false', {
    method: 'PATCH',
    body: JSON.stringify({ read: true }),
  });
}

export async function deleteNotif(id: string): Promise<void> {
  await dbFetch(`user_notifications?id=eq.${id}`, { method: 'DELETE' });
}

// ── Админские операции (требуют admin role на стороне RLS / Edge Function) ──

export async function adminSendNotification(payload: SendNotifPayload): Promise<void> {
  const FUNC_URL = (import.meta.env.VITE_API_URL as string) + '/functions/v1/admin-send-notification';
  const token = localStorage.getItem('access_token') ?? '';
  const res = await fetch(FUNC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Ошибка отправки: ${res.status} ${txt.slice(0, 100)}`);
  }
}

export async function adminFetchAllNotifications(): Promise<UserNotification[]> {
  const res = await fetch(
    `${REST_URL}/user_notifications?select=*&order=created_at.desc&limit=100`,
    { headers: { ...getAuthHeaders(), 'Prefer': 'count=exact' } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<UserNotification[]>;
}

export async function adminDeleteNotif(id: string): Promise<void> {
  await dbFetch(`user_notifications?id=eq.${id}`, { method: 'DELETE' });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export const NOTIF_META: Record<NotifType, { emoji: string; label: string; color: string }> = {
  info:        { emoji: '📌', label: 'Информация',   color: '#3b82f6' },
  success:     { emoji: '✅', label: 'Успех',         color: '#10b981' },
  warning:     { emoji: '⚠️', label: 'Предупреждение', color: '#f59e0b' },
  error:       { emoji: '❌', label: 'Ошибка',        color: '#ef4444' },
  token_gift:  { emoji: '🎁', label: 'Подарок токенов', color: '#8b5cf6' },
  store_alert: { emoji: '📦', label: 'Магазин',       color: '#f97316' },
  system:      { emoji: '⚙️', label: 'Система',       color: '#64748b' },
};

export function formatNotifTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'только что';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
