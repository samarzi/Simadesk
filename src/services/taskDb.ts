/**
 * Task & Reminder DB service — CRUD via Supabase REST.
 * Both tables are RLS-protected by company_id through company_members.
 */

import { dbFetch, getAuthHeaders } from './dbClient';
import { companyService } from './companyService';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  company_id: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'none' | 'blue' | 'yellow' | 'red';
  scheduled_date: string | null; // YYYY-MM-DD — когда планирую сделать
  due_date: string | null;       // YYYY-MM-DD — дедлайн (крайний срок)
  due_time: string | null;       // HH:MM (start time)
  end_time: string | null;       // HH:MM (end time)
  all_day: boolean;
  tags: string;              // comma-separated
  sort_order: number;
  completed_at: string | null;
  parent_id: string | null;
  assignee_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Reminder {
  id: string;
  company_id: string;
  task_id: string | null;
  title: string;
  remind_at: string;         // ISO timestamptz
  repeat: 'none' | 'daily' | 'weekly' | 'monthly';
  dismissed: boolean;
  created_at: string;
}

export type TaskCreate = Omit<Task, 'id' | 'company_id' | 'created_at' | 'updated_at' | 'completed_at'>;
export type TaskUpdate = Partial<Omit<Task, 'id' | 'company_id' | 'created_at' | 'updated_at'>>;
export type ReminderCreate = Omit<Reminder, 'id' | 'company_id' | 'created_at'>;
export type ReminderUpdate = Partial<Omit<Reminder, 'id' | 'company_id' | 'created_at'>>;

export interface TaskComment {
  id: string;
  company_id: string;
  task_id: string;
  author_id: string;
  body: string;
  created_at: string;
}

export interface TaskAttachment {
  id: string;
  company_id: string;
  task_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  storage_path: string;
  uploaded_by: string;
  created_at: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function cid(): string {
  const id = companyService.getActiveId();
  if (!id) throw new Error('Не выбрана компания');
  return id;
}

function first<T>(r: T | T[]): T {
  return Array.isArray(r) ? r[0] : r;
}

// ── Task CRUD ────────────────────────────────────────────────────────────────

export const taskDb = {
  getTasks: async (): Promise<Task[]> => {
    const id = companyService.getActiveId();
    if (!id) return [];
    return dbFetch<Task[]>(
      `tasks?company_id=eq.${id}&select=*&order=sort_order.asc,created_at.desc`,
    );
  },

  createTask: async (data: TaskCreate): Promise<Task> => {
    const r = await dbFetch<Task[]>('tasks', {
      method: 'POST',
      body: JSON.stringify({ company_id: cid(), ...data }),
    });
    return first(r);
  },

  updateTask: async (id: string, data: TaskUpdate): Promise<Task> => {
    const r = await dbFetch<Task[]>(`tasks?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return first(r);
  },

  deleteTask: async (id: string): Promise<void> => {
    await dbFetch(`tasks?id=eq.${id}`, { method: 'DELETE' });
  },
};

// ── Reminder CRUD ────────────────────────────────────────────────────────────

export const reminderDb = {
  getReminders: async (): Promise<Reminder[]> => {
    const id = companyService.getActiveId();
    if (!id) return [];
    return dbFetch<Reminder[]>(
      `reminders?company_id=eq.${id}&select=*&order=remind_at.asc`,
    );
  },

  createReminder: async (data: ReminderCreate): Promise<Reminder> => {
    const r = await dbFetch<Reminder[]>('reminders', {
      method: 'POST',
      body: JSON.stringify({ company_id: cid(), ...data }),
    });
    return first(r);
  },

  updateReminder: async (id: string, data: ReminderUpdate): Promise<Reminder> => {
    const r = await dbFetch<Reminder[]>(`reminders?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return first(r);
  },

  deleteReminder: async (id: string): Promise<void> => {
    await dbFetch(`reminders?id=eq.${id}`, { method: 'DELETE' });
  },
};

// ── Comment CRUD ────────────────────────────────────────────────────────

export const commentDb = {
  getComments: async (taskId: string): Promise<TaskComment[]> => {
    const id = companyService.getActiveId();
    if (!id) return [];
    return dbFetch<TaskComment[]>(
      `task_comments?company_id=eq.${id}&task_id=eq.${taskId}&select=*&order=created_at.asc`,
    );
  },

  createComment: async (taskId: string, authorId: string, body: string): Promise<TaskComment> => {
    const r = await dbFetch<TaskComment[]>('task_comments', {
      method: 'POST',
      body: JSON.stringify({ company_id: cid(), task_id: taskId, author_id: authorId, body }),
    });
    return first(r);
  },

  deleteComment: async (id: string): Promise<void> => {
    await dbFetch(`task_comments?id=eq.${id}`, { method: 'DELETE' });
  },
};

// ── Attachment CRUD ─────────────────────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL as string;
const STORAGE_BUCKET = 'task-files';

export const attachmentDb = {
  getAttachments: async (taskId: string): Promise<TaskAttachment[]> => {
    const id = companyService.getActiveId();
    if (!id) return [];
    return dbFetch<TaskAttachment[]>(
      `task_attachments?company_id=eq.${id}&task_id=eq.${taskId}&select=*&order=created_at.asc`,
    );
  },

  /** Upload file to Supabase Storage, then create metadata row */
  uploadFile: async (taskId: string, uploadedBy: string, file: File): Promise<TaskAttachment> => {
    const companyId = cid();
    const storagePath = `${companyId}/${taskId}/${Date.now()}_${file.name}`;

    // Upload to storage
    const headers = getAuthHeaders();
    delete (headers as any)['Content-Type']; // let browser set multipart
    delete (headers as any)['Prefer'];

    const uploadRes = await fetch(
      `${API_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
      { method: 'POST', headers, body: file },
    );
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Storage upload failed: ${errText.slice(0, 200)}`);
    }

    // Create metadata record
    const r = await dbFetch<TaskAttachment[]>('task_attachments', {
      method: 'POST',
      body: JSON.stringify({
        company_id: companyId,
        task_id: taskId,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type || 'application/octet-stream',
        storage_path: storagePath,
        uploaded_by: uploadedBy,
      }),
    });
    return first(r);
  },

  /** Get a signed download URL (60 min expiry) */
  getDownloadUrl: async (storagePath: string): Promise<string> => {
    const headers = getAuthHeaders();
    const res = await fetch(
      `${API_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${storagePath}`,
      { method: 'POST', headers, body: JSON.stringify({ expiresIn: 3600 }) },
    );
    if (!res.ok) throw new Error('Failed to get signed URL');
    const data = await res.json();
    return `${API_URL}/storage/v1${data.signedURL}`;
  },

  deleteAttachment: async (id: string, storagePath: string): Promise<void> => {
    // Delete from storage
    const headers = getAuthHeaders();
    await fetch(
      `${API_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
      { method: 'DELETE', headers },
    );
    // Delete metadata
    await dbFetch(`task_attachments?id=eq.${id}`, { method: 'DELETE' });
  },
};
