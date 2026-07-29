/**
 * Roadmap Tasks DB — CRUD через Supabase REST.
 * Задачи дорожной карты, управляемые из админ-панели.
 */

import { dbFetch } from './dbClient';

// ── Types ────────────────────────────────────────────────────────────────────

export type Quadrant = 'urgent_important' | 'important_not_urgent' | 'urgent_not_important' | 'not_urgent_not_important';
export type RoadmapStatus = 'todo' | 'in_progress' | 'done';

export interface RoadmapTask {
  id: string;
  title: string;
  description: string;
  quadrant: Quadrant;
  status: RoadmapStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type RoadmapTaskCreate = Omit<RoadmapTask, 'id' | 'created_at' | 'updated_at'>;
export type RoadmapTaskUpdate = Partial<Omit<RoadmapTask, 'id' | 'created_at' | 'updated_at'>>;

// ── Labels ───────────────────────────────────────────────────────────────────

export const QUADRANT_LABELS: Record<Quadrant, string> = {
  urgent_important:          'Срочно + Важно',
  important_not_urgent:      'Важно + Не срочно',
  urgent_not_important:      'Срочно + Не важно',
  not_urgent_not_important:  'Не срочно + Не важно',
};

export const STATUS_LABELS: Record<RoadmapStatus, string> = {
  todo:        'К выполнению',
  in_progress: 'В работе',
  done:        'Готово',
};

export const QUADRANT_COLORS: Record<Quadrant, string> = {
  urgent_important:          '#ef4444',
  important_not_urgent:      '#f59e0b',
  urgent_not_important:      '#3b82f6',
  not_urgent_not_important:  '#6b7280',
};

// ── CRUD ─────────────────────────────────────────────────────────────────────

function first<T>(r: T | T[]): T {
  return Array.isArray(r) ? r[0] : r;
}

export const roadmapDb = {
  /** Загрузить все задачи (кроме удалённых). */
  getTasks: async (): Promise<RoadmapTask[]> => {
    return dbFetch<RoadmapTask[]>(
      'roadmap_tasks?status=neq.deleted&select=*&order=sort_order.asc,created_at.desc',
    );
  },

  /** Создать задачу. */
  createTask: async (data: RoadmapTaskCreate): Promise<RoadmapTask> => {
    const r = await dbFetch<RoadmapTask[]>('roadmap_tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return first(r);
  },

  /** Обновить задачу. */
  updateTask: async (id: string, data: RoadmapTaskUpdate): Promise<RoadmapTask> => {
    const r = await dbFetch<RoadmapTask[]>(`roadmap_tasks?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
    });
    return first(r);
  },

  /** Удалить задачу (пометить как deleted). */
  deleteTask: async (id: string): Promise<void> => {
    await dbFetch(`roadmap_tasks?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'deleted', updated_at: new Date().toISOString() }),
    });
  },
};
