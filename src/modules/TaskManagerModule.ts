/**
 * TaskManagerModule — tasks, reminders, list / kanban / calendar / eisenhower views.
 * v4: SVG icons, compact design, priority-sorted, collapsible extras in modal.
 */

import { taskDb, reminderDb, commentDb, attachmentDb, Task, Reminder, TaskComment, TaskAttachment, TaskCreate, TaskUpdate } from '@/services/taskDb';
import { companyService } from '@/services/companyService';
import { authService } from '@/services/authService';
import { apiService } from '@/services/api';
import { esc } from '@/utils/format';
import { copyButton } from '@/utils/copyButton';
import type { Product } from '@/types/index';

// ── Constants ────────────────────────────────────────────────────────────────

type ViewMode = 'list' | 'kanban' | 'calendar' | 'eisenhower';
type CalendarScope = 'month' | 'week' | 'day';
type Status = Task['status'];
type Priority = Task['priority'];

interface Member {
  id: string;
  user_id: string;
  role: string;
  joined_at: string;
  first_name: string;
  telegram_username: string | null;
  photo_url: string | null;
}

const PRIORITY_COLOR: Record<Priority, string> = {
  red: '#ef4444', yellow: '#f59e0b', blue: '#3b82f6', none: 'transparent',
};
const PRIORITY_LABEL: Record<Priority, string> = {
  red: 'Срочный', yellow: 'Высокий', blue: 'Средний', none: 'Без приоритета',
};
const PRIORITY_WEIGHT: Record<Priority, number> = {
  red: 0, yellow: 1, blue: 2, none: 3,
};
const STATUS_LABEL: Record<Status, string> = {
  todo: 'К выполнению', in_progress: 'В работе', done: 'Готово',
};
const STATUS_COLS: Status[] = ['todo', 'in_progress', 'done'];

const DAY_NAMES_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTH_NAMES_RU = [
  'Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь',
];

const EISENHOWER_QUADRANTS = [
  { key: 'ui', label: 'Срочно и Важно',       color: '#ef4444' },
  { key: 'ni', label: 'Не срочно, но Важно',   color: '#3b82f6' },
  { key: 'un', label: 'Срочно, но Не важно',   color: '#f59e0b' },
  { key: 'nn', label: 'Не срочно и Не важно',  color: '#6b7280' },
] as const;
type EQKey = typeof EISENHOWER_QUADRANTS[number]['key'];

// ── SVG Icons ───────────────────────────────────────────────────────────────

const IC = {
  list: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="5" y1="3" x2="14" y2="3"/><line x1="5" y1="8" x2="14" y2="8"/><line x1="5" y1="13" x2="14" y2="13"/><circle cx="2" cy="3" r="1" fill="currentColor"/><circle cx="2" cy="8" r="1" fill="currentColor"/><circle cx="2" cy="13" r="1" fill="currentColor"/></svg>`,
  kanban: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="4" height="14" rx="1"/><rect x="6" y="1" width="4" height="9" rx="1"/><rect x="11" y="1" width="4" height="11" rx="1"/></svg>`,
  calendar: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="2" width="14" height="13" rx="2"/><line x1="1" y1="6" x2="15" y2="6"/><line x1="5" y1="0.5" x2="5" y2="3.5"/><line x1="11" y1="0.5" x2="11" y2="3.5"/></svg>`,
  matrix: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2"><line x1="7" y1="2" x2="7" y2="12"/><line x1="2" y1="7" x2="12" y2="7"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="4.5"/><line x1="9.5" y1="9.5" x2="13" y2="13"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 4h9l-.7 8.5a1 1 0 01-1 .9H4.2a1 1 0 01-1-.9L2.5 4z"/><line x1="1" y1="4" x2="13" y2="4"/><path d="M5 4V2.5a1 1 0 011-1h2a1 1 0 011 1V4"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2"><polyline points="2,6 5,9 10,3"/></svg>`,
  chevron: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3,1 7,5 3,9"/></svg>`,
  clock: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="6" cy="6" r="5"/><polyline points="6,3 6,6 8,7.5"/></svg>`,
  deadline: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="2" width="10" height="9" rx="1.5"/><line x1="1" y1="5" x2="11" y2="5"/><line x1="3.5" y1="0.5" x2="3.5" y2="3.5"/><line x1="8.5" y1="0.5" x2="8.5" y2="3.5"/></svg>`,
  user: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="6" cy="4" r="2.5"/><path d="M1.5 11c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"/></svg>`,
  attach: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M6.5 3v5.5a2 2 0 01-4 0V3.5a1.25 1.25 0 012.5 0V8"/></svg>`,
  comment: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1 2.5a1.5 1.5 0 011.5-1.5h7A1.5 1.5 0 0111 2.5v5a1.5 1.5 0 01-1.5 1.5H5L2.5 11V9H2.5A1.5 1.5 0 011 7.5z"/></svg>`,
  bell: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 5a3 3 0 016 0c0 3 1.5 4 1.5 4H1.5S3 8 3 5z"/><path d="M4.5 9.5a1.5 1.5 0 003 0"/></svg>`,
  subtask: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 2v5a2 2 0 002 2h4"/><polyline points="7,7 9,9 7,11"/></svg>`,
  expand: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3,4.5 6,7.5 9,4.5"/></svg>`,
  left: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,2 4,7 9,12"/></svg>`,
  right: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="5,2 10,7 5,12"/></svg>`,
  file: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 1h5l4 4v8H3z"/><polyline points="8,1 8,5 12,5"/></svg>`,
  image: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="12" height="12" rx="1.5"/><circle cx="4.5" cy="4.5" r="1.5"/><polyline points="1,11 5,7 8,10 10,8 13,11"/></svg>`,
  send: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 7h8M12 7L1 1v4.5L5 7l-4 1.5V13z"/></svg>`,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function uuid(): string { return crypto.randomUUID(); }
function pad(n: number): string { return n < 10 ? '0' + n : '' + n; }
function fmtDate(d: string | null): string {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}
function fmtTime(t: string | null): string {
  if (!t) return '';
  return t.slice(0, 5);
}
function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayOfWeekMon(d: Date): number { return (d.getDay() + 6) % 7; }
function weekNumber(d: Date): number {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function renderRichText(text: string): string {
  let s = esc(text);
  s = s.replace(/@([\wА-Яа-яёЁ]+(?:\s[\wА-Яа-яёЁ]+)?)/g,
    '<span class="tm-mention">@$1</span>');
  s = s.replace(/\/([\wА-Яа-яёЁ0-9._-]+)/g,
    '<span class="tm-article-link" data-article="$1" title="Перейти к товару $1">/$1</span>');
  return s;
}

/** Small colored dot for priority */
function priorityDot(p: Priority, size = 8): string {
  if (p === 'none') return '';
  return `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${PRIORITY_COLOR[p]};flex-shrink:0"></span>`;
}

function classifyEisenhower(t: Task): EQKey {
  // Priority color directly maps to quadrant; due_date is secondary for uncolored tasks
  if (t.priority === 'red')    return 'ui'; // Срочно и Важно
  if (t.priority === 'yellow') return 'un'; // Срочно, но Не важно
  if (t.priority === 'blue')   return 'ni'; // Не срочно, но Важно
  // For uncolored tasks fall back to due_date proximity
  const soon = new Date(); soon.setDate(soon.getDate() + 3);
  const isUrgent = t.due_date != null && t.due_date <= toISO(soon);
  return isUrgent ? 'un' : 'nn';
}

function getArticle(p: Product): string {
  return p.data['Артикул'] || p.data['Артикул*'] || Object.values(p.data)[0] || '—';
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1048576).toFixed(1) + ' МБ';
}

// ── Module ───────────────────────────────────────────────────────────────────

export class TaskManagerModule {
  private el: HTMLElement;
  private tasks: Task[] = [];
  private reminders: Reminder[] = [];
  private view: ViewMode = 'list';
  private calScope: CalendarScope = 'month';
  private calDate = new Date();
  private filterPriority: Priority | 'all' = 'all';
  private filterStatus: Status | 'all' = 'all';
  private searchQ = '';
  private editingTask: Task | null = null;
  private reminderTimer: ReturnType<typeof setInterval> | null = null;
  private dragTaskId: string | null = null;

  private members: Member[] = [];
  private products: Product[] = [];
  private membersLoaded = false;
  private productsLoaded = false;

  private acType: '@' | '/' | null = null;
  private acQuery = '';
  private acIndex = 0;
  private acStartPos = 0;
  private acVisible = false;

  private productPopup: Product | null = null;
  private confirmDeleteId: string | null = null;
  private completedCollapsed = true;

  private editComments: TaskComment[] = [];
  private editAttachments: TaskAttachment[] = [];
  private uploadingFile = false;

  // When true the modal is already open — skip entrance animation on re-render
  private modalIsRefresh = false;

  // Modal extras — which sections are visible
  private modalShowSubs = false;
  private modalShowReminders = false;
  private modalShowFiles = false;
  private modalShowComments = false;
  private modalShowDeadline = false;
  private modalShowDate = false;

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.style.display = 'none';
  }

  show(): void { this.el.style.display = ''; this.load(); this.startReminderChecker(); }
  hide(): void { this.el.style.display = 'none'; this.stopReminderChecker(); }

  private async load(): Promise<void> {
    try {
      const [tasks, reminders] = await Promise.all([taskDb.getTasks(), reminderDb.getReminders()]);
      this.tasks = tasks;
      this.reminders = reminders;
    } catch (e) { console.error('[TaskManager] load error', e); }
    this.render();
    this.loadRefData();
  }

  private async loadRefData(): Promise<void> {
    const cid = companyService.getActiveId();
    if (!this.membersLoaded && cid) {
      try {
        const raw = await companyService.getMembers(cid) as any[];
        // Flatten nested users join from Supabase
        this.members = raw.map(m => ({
          id: m.id,
          user_id: m.user_id,
          role: m.role,
          joined_at: m.joined_at,
          first_name: m.users?.first_name ?? m.first_name ?? '',
          telegram_username: m.users?.telegram_username ?? m.telegram_username ?? null,
          photo_url: m.users?.photo_url ?? m.photo_url ?? null,
        }));
        this.membersLoaded = true;
      } catch (e) { console.error('[TaskManager] members load error', e); }
    }
    if (!this.productsLoaded) {
      try {
        this.products = await apiService.getAllProducts();
        this.productsLoaded = true;
      } catch (e) { console.error('[TaskManager] products load error', e); }
    }
  }

  // ── Reminder checker ───────────────────────────────────────────────────

  private startReminderChecker(): void {
    this.stopReminderChecker();
    this.checkReminders();
    this.reminderTimer = setInterval(() => this.checkReminders(), 30_000);
  }
  private stopReminderChecker(): void {
    if (this.reminderTimer) { clearInterval(this.reminderTimer); this.reminderTimer = null; }
  }
  private async checkReminders(): Promise<void> {
    const now = new Date();
    for (const r of this.reminders) {
      if (r.dismissed) continue;
      const rDate = new Date(r.remind_at);
      if (rDate <= now) {
        this.showNotification(r);
        if (r.repeat === 'none') {
          await reminderDb.updateReminder(r.id, { dismissed: true });
          r.dismissed = true;
        } else {
          const next = new Date(rDate);
          if (r.repeat === 'daily') next.setDate(next.getDate() + 1);
          else if (r.repeat === 'weekly') next.setDate(next.getDate() + 7);
          else if (r.repeat === 'monthly') next.setMonth(next.getMonth() + 1);
          await reminderDb.updateReminder(r.id, { remind_at: next.toISOString() });
          r.remind_at = next.toISOString();
        }
      }
    }
  }
  private showNotification(r: Reminder): void {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') Notification.requestPermission();
    if (Notification.permission === 'granted') {
      new Notification('SimaDesk — Напоминание', { body: r.title, icon: '/favicon.ico' });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private get currentUserId(): string { return authService.getUser()?.id || ''; }

  private get filtered(): Task[] {
    return this.tasks.filter(t => {
      if (this.filterPriority !== 'all' && t.priority !== this.filterPriority) return false;
      if (this.filterStatus !== 'all' && t.status !== this.filterStatus) return false;
      if (this.searchQ) {
        const q = this.searchQ.toLowerCase();
        if (!t.title.toLowerCase().includes(q) && !t.tags.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  /** Sort: priority (red→yellow→blue→none), then by due_date */
  private sorted(list: Task[]): Task[] {
    return [...list].sort((a, b) => {
      const pw = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
      if (pw !== 0) return pw;
      if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
      if (a.due_date) return -1;
      if (b.due_date) return 1;
      return 0;
    });
  }

  private topLevel(list: Task[]): Task[] { return list.filter(t => !t.parent_id); }
  private subtasksOf(parentId: string): Task[] { return this.tasks.filter(t => t.parent_id === parentId); }

  private effectiveDueDate(t: Task): string | null {
    if (t.due_date) return t.due_date;
    if (t.parent_id) {
      const parent = this.tasks.find(x => x.id === t.parent_id);
      if (parent) return parent.due_date;
    }
    return null;
  }

  /** Subtask inherits parent all_day if own is not set */
  private effectiveAllDay(t: Task): boolean {
    if (t.due_date) return t.all_day;
    if (t.parent_id) {
      const parent = this.tasks.find(x => x.id === t.parent_id);
      if (parent) return parent.all_day;
    }
    return t.all_day;
  }

  private effectiveDueTime(t: Task): string | null {
    if (t.due_time) return t.due_time;
    if (t.parent_id) {
      const parent = this.tasks.find(x => x.id === t.parent_id);
      if (parent) return parent.due_time;
    }
    return null;
  }

  private memberName(userId: string | null): string {
    if (!userId) return '';
    const m = this.members.find(x => x.user_id === userId);
    if (!m) return '';
    if (m.first_name && m.telegram_username) return `${m.first_name} (@${m.telegram_username})`;
    return m.first_name || (m.telegram_username ? `@${m.telegram_username}` : 'Участник');
  }

  private memberShortName(userId: string | null): string {
    if (!userId) return '';
    const m = this.members.find(x => x.user_id === userId);
    if (!m) return '';
    return m.first_name || (m.telegram_username ? `@${m.telegram_username}` : '');
  }

  private memberAvatar(userId: string | null, size = 20): string {
    if (!userId) return '';
    const m = this.members.find(x => x.user_id === userId);
    if (!m) return '';
    const name = esc(m.first_name || m.telegram_username || '?');
    if (m.photo_url) {
      return `<img src="${esc(m.photo_url)}" alt="${name}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0" title="${name}">`;
    }
    const letter = (m.first_name || m.telegram_username || '?').charAt(0).toUpperCase();
    return `<span class="tm-avatar" style="width:${size}px;height:${size}px;font-size:${size * 0.5}px" title="${name}">${letter}</span>`;
  }

  // ── RENDER ──────────────────────────────────────────────────────────────

  render(): void {
    const viewContent =
      this.view === 'list' ? this.renderList() :
      this.view === 'kanban' ? this.renderKanban() :
      this.view === 'eisenhower' ? this.renderEisenhower() :
      this.renderCalendar();

    this.el.innerHTML = `
      ${this.renderStyles()}
      <div class="tm">
        ${this.renderToolbar()}
        ${viewContent}
      </div>
      ${this.editingTask ? this.renderModal() : ''}
      ${this.productPopup ? this.renderProductPopup() : ''}
      ${this.confirmDeleteId ? this.renderConfirmDialog() : ''}
    `;
    this.bind();
  }

  // ── Styles ──────────────────────────────────────────────────────────────

  private renderStyles(): string {
    return `<style>
.tm{padding:20px 24px 100px;max-width:1400px;margin:0 auto;color:var(--text);font-family:inherit}
.tm *{box-sizing:border-box}
.tm svg{vertical-align:middle}

/* Toolbar */
.tm-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.tm-toolbar .tm-title{font-size:20px;font-weight:700;margin-right:auto;letter-spacing:-.3px}
.tm-view-btn{background:var(--bg3);border:1px solid var(--border);color:var(--text3);
  padding:6px 12px;border-radius:var(--r2);cursor:pointer;font-size:12px;transition:all .15s;
  display:flex;align-items:center;gap:5px}
.tm-view-btn:hover{color:var(--text);background:var(--bg4)}
.tm-view-btn.active{background:var(--text);color:var(--bg);border-color:var(--text)}
.tm-add-btn{background:#6366f1;color:#fff;border:none;padding:6px 14px;border-radius:var(--r2);
  cursor:pointer;font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px;transition:all .15s}
.tm-add-btn:hover{background:#4f46e5}

/* Filters row */
.tm-filters{display:flex;gap:6px;align-items:center}
.tm-filters select{background:var(--bg3);color:var(--text2);border:1px solid var(--border);
  padding:5px 8px;border-radius:var(--r2);font-size:11px;cursor:pointer}
.tm-filters select:focus{outline:none;border-color:#6366f1}
.tm-search-wrap{position:relative}
.tm-search-wrap svg{position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--text3);pointer-events:none}
.tm-search{background:var(--bg3);color:var(--text);border:1px solid var(--border);
  padding:6px 10px 6px 26px;border-radius:var(--r2);font-size:12px;width:180px}
.tm-search:focus{outline:none;border-color:#6366f1}
.tm-search::placeholder{color:var(--text3)}

/* Quick add */
.tm-quick{display:flex;gap:6px;margin-bottom:12px}
.tm-quick input{flex:1;background:var(--bg2);color:var(--text);border:1px solid var(--border);
  padding:8px 12px;border-radius:var(--r2);font-size:13px}
.tm-quick input:focus{outline:none;border-color:#6366f1}
.tm-quick input::placeholder{color:var(--text3)}

/* Avatar */
.tm-avatar{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;
  background:var(--bg4);color:var(--text2);font-weight:600;flex-shrink:0}

/* Tag */
.tm-tag{background:var(--bg4);padding:1px 5px;border-radius:3px;font-size:10px;color:var(--text2)}

/* ── LIST VIEW ── */
.tm-list-group{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);
  overflow:hidden;margin-bottom:3px}
.tm-list-row{display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;
  transition:background .1s;border-bottom:1px solid var(--border)}
.tm-list-row:last-child{border-bottom:none}
.tm-list-row:hover{background:var(--bg3)}
.tm-list-row.done .tm-row-title{text-decoration:line-through;opacity:.5}
.tm-list-row.sub{padding-left:30px;padding-top:3px;padding-bottom:3px;background:var(--bg2)}
.tm-list-row.sub .tm-row-title{font-size:11px;color:var(--text2)}
.tm-list-row.sub .tm-row-meta{font-size:9px}
.tm-list-row.sub .tm-prio-bar{width:2px}
.tm-list-row.sub .tm-check{width:14px;height:14px}
.tm-prio-bar{width:3px;align-self:stretch;border-radius:2px;flex-shrink:0}
.tm-check{width:16px;height:16px;border-radius:50%;border:2px solid var(--text3);cursor:pointer;
  flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .12s}
.tm-check:hover{border-color:#6366f1}
.tm-check.checked{background:#6366f1;border-color:#6366f1}
.tm-row-body{flex:1;min-width:0}
.tm-row-title{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tm-row-meta{display:flex;gap:5px;margin-top:1px;font-size:10px;color:var(--text3);align-items:center;flex-wrap:wrap}
.tm-row-info{font-size:8px;color:var(--text3);opacity:.35;margin-top:0}
.tm-del-btn{background:none;border:none;color:var(--text3);cursor:pointer;padding:4px;border-radius:4px;
  transition:all .12s;opacity:.4;display:flex;align-items:center}
.tm-del-btn:hover{color:#ef4444;opacity:1;background:rgba(239,68,68,.1)}

/* Completed section */
.tm-completed-hdr{display:flex;align-items:center;gap:6px;padding:8px 12px;cursor:pointer;
  color:var(--text3);font-size:12px;font-weight:500;margin-top:8px;user-select:none}
.tm-completed-hdr:hover{color:var(--text2)}
.tm-completed-hdr svg{transition:transform .15s}
.tm-completed-hdr.open svg{transform:rotate(90deg)}

/* ── KANBAN ── */
.tm-kanban{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;min-height:400px}
.tm-kb-col{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);padding:10px;min-height:300px}
.tm-kb-col.drag-over{border-color:#6366f1;background:rgba(59,130,246,.04)}
.tm-kb-hdr{font-size:13px;font-weight:600;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
.tm-kb-count{background:var(--bg4);padding:1px 7px;border-radius:10px;font-size:10px;color:var(--text3)}
.tm-kb-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2);
  padding:8px 10px;margin-bottom:6px;cursor:grab;transition:transform .1s,box-shadow .1s;
  border-left:3px solid transparent}
.tm-kb-card:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.2)}
.tm-kb-card.dragging{opacity:.3}
.tm-kb-card-title{font-size:12px;font-weight:500;margin-bottom:3px;display:flex;align-items:center;gap:4px}
.tm-kb-card-meta{display:flex;gap:5px;font-size:10px;color:var(--text3);flex-wrap:wrap;align-items:center}
.tm-kb-quick{margin-top:8px}
.tm-kb-quick input{width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border);
  padding:5px 8px;border-radius:var(--r2);font-size:11px}
.tm-kb-quick input:focus{outline:none;border-color:#6366f1}
.tm-kb-quick input::placeholder{color:var(--text3)}

/* ── EISENHOWER ── */
.tm-eisenhower{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:12px;min-height:500px}
.tm-eq{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);padding:10px;
  min-height:240px;overflow-y:auto}
.tm-eq.drag-over{border-color:#6366f1;background:rgba(59,130,246,.04)}
.tm-eq-hdr{font-size:12px;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.tm-eq-count{background:var(--bg4);padding:1px 7px;border-radius:10px;font-size:10px;color:var(--text3);margin-left:auto}
.tm-eq-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2);
  padding:6px 8px;margin-bottom:4px;cursor:grab;font-size:11px;transition:transform .1s}
.tm-eq-card:hover{transform:translateY(-1px)}
.tm-eq-card.dragging{opacity:.3}
.tm-eq-card-title{font-weight:500;margin-bottom:2px;display:flex;align-items:center;gap:4px}
.tm-eq-card-meta{display:flex;gap:5px;font-size:10px;color:var(--text3);align-items:center}

/* ── CALENDAR ── */
.tm-cal-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.tm-cal-nav{background:var(--bg3);border:1px solid var(--border);color:var(--text2);
  padding:5px 10px;border-radius:var(--r2);cursor:pointer;font-size:12px;transition:all .12s;
  display:flex;align-items:center}
.tm-cal-nav:hover{background:var(--bg4);color:var(--text)}
.tm-cal-title{font-size:14px;font-weight:600;min-width:180px;text-align:center}
.tm-cal-scope-btn{background:var(--bg3);border:1px solid var(--border);color:var(--text3);
  padding:4px 8px;border-radius:var(--r2);cursor:pointer;font-size:11px;transition:all .12s}
.tm-cal-scope-btn:hover{background:var(--bg4)}
.tm-cal-scope-btn.active{background:#6366f1;color:#fff;border-color:#6366f1}

.tm-cal-grid{display:grid;grid-template-columns:36px repeat(7,1fr);gap:1px;background:var(--border);
  border:1px solid var(--border);border-radius:var(--r2);overflow:hidden}
.tm-cal-wk{background:var(--bg2);padding:3px;font-size:9px;color:var(--text3);
  display:flex;align-items:flex-start;justify-content:center}
.tm-cal-hdr{background:var(--bg3);padding:6px;text-align:center;font-size:11px;font-weight:600;color:var(--text2)}
.tm-cal-cell{background:var(--bg2);min-height:80px;padding:3px;position:relative;vertical-align:top}
.tm-cal-cell.today{background:rgba(59,130,246,.06)}
.tm-cal-cell.other{opacity:.3}
.tm-cal-day{font-size:10px;font-weight:600;color:var(--text2);margin-bottom:1px}
.tm-cal-task{font-size:9px;padding:1px 3px;border-radius:2px;margin-bottom:1px;
  cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;line-height:1.2}
.tm-cal-allday{border-left:2px solid;padding-left:3px;background:rgba(255,255,255,.04);color:var(--text)}

.tm-cal-week-grid{display:grid;grid-template-columns:50px repeat(7,1fr);gap:1px;
  background:var(--border);border:1px solid var(--border);border-radius:var(--r2);overflow:hidden}
.tm-cal-day-grid{display:grid;grid-template-columns:50px 1fr;gap:1px;
  background:var(--border);border:1px solid var(--border);border-radius:var(--r2);overflow:hidden}
.tm-cal-hour{background:var(--bg2);padding:3px 5px;font-size:9px;color:var(--text3);
  height:40px;display:flex;align-items:flex-start;justify-content:flex-end}
.tm-cal-hour-cell{background:var(--bg2);height:40px;position:relative;border-bottom:1px solid var(--border)}
.tm-cal-hour-cell.today-col{background:rgba(59,130,246,.03)}
.tm-cal-time-task{position:absolute;left:2px;right:2px;border-radius:2px;padding:1px 3px;
  font-size:9px;color:#fff;overflow:hidden;cursor:pointer;z-index:1}

/* ── MODAL ── */
.tm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;display:flex;
  align-items:center;justify-content:center;animation:tmFade .15s ease both}
.tm-overlay.no-anim,.tm-overlay.no-anim .tm-modal{animation:none!important}
@keyframes tmFade{from{opacity:0}to{opacity:1}}
@keyframes tmModalIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.tm-modal{background:var(--bg2);border:1px solid var(--border);border-radius:12px;
  width:720px;max-width:95vw;max-height:90vh;overflow-y:auto;padding:24px 28px;
  box-shadow:0 20px 60px rgba(0,0,0,.5);animation:tmModalIn .15s ease both}
.tm-modal h3{margin:0 0 16px;font-size:17px;font-weight:600;display:flex;align-items:center;gap:8px}
.tm-modal label{display:block;font-size:11px;color:var(--text3);margin-bottom:3px;margin-top:12px;
  text-transform:uppercase;letter-spacing:.5px;font-weight:500}
.tm-modal input,.tm-modal textarea,.tm-modal select{width:100%;background:var(--bg3);
  color:var(--text);border:1px solid var(--border);padding:7px 10px;border-radius:var(--r2);
  font-size:12px;font-family:inherit}
.tm-modal input:focus,.tm-modal textarea:focus,.tm-modal select:focus{outline:none;border-color:#6366f1}
.tm-modal textarea{min-height:60px;resize:vertical}
.tm-modal-row{display:flex;gap:10px}
.tm-modal-row>*{flex:1}

/* Priority toggle */
.tm-prio-btns{display:flex;gap:6px;margin-top:4px}
.tm-prio-btn{width:28px;height:28px;border-radius:50%;border:2px solid var(--border);background:transparent;
  cursor:pointer;transition:all .15s;position:relative;display:flex;align-items:center;justify-content:center}
.tm-prio-btn:hover{transform:scale(1.15)}
.tm-prio-btn .tm-prio-inner{width:14px;height:14px;border-radius:50%;transition:all .15s}
.tm-prio-btn.active{border-width:2px;transform:scale(1.2);box-shadow:0 0 10px rgba(255,255,255,.1)}
.tm-prio-btn .tm-prio-tip{position:absolute;bottom:-18px;font-size:9px;color:var(--text3);
  white-space:nowrap;display:none;pointer-events:none}
.tm-prio-btn:hover .tm-prio-tip{display:block}

/* All day toggle */
.tm-allday-row{display:flex;align-items:center;gap:8px;margin-top:6px}
.tm-allday-row label{margin:0;text-transform:none;letter-spacing:0}
.tm-toggle{position:relative;width:34px;height:18px;cursor:pointer}
.tm-toggle input{opacity:0;width:0;height:0}
.tm-toggle span{position:absolute;inset:0;background:var(--bg4);border-radius:9px;transition:background .2s}
.tm-toggle span::after{content:'';position:absolute;width:14px;height:14px;left:2px;top:2px;
  background:var(--text3);border-radius:50%;transition:transform .2s}
.tm-toggle input:checked+span{background:#6366f1}
.tm-toggle input:checked+span::after{transform:translateX(16px);background:#fff}

/* Extras add-module button & dropdown */
.tm-extras-wrap{margin-top:14px}
.tm-mod-cards{display:flex;gap:6px;flex-wrap:wrap}
.tm-mod-card{display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:8px;
  border:1.5px solid var(--border);background:var(--bg3);color:var(--text3);cursor:pointer;
  font-size:11px;font-weight:500;transition:all .15s}
.tm-mod-card:hover{background:var(--bg4);color:var(--text);border-color:var(--text3)}
.tm-mod-card.active{background:rgba(99,102,241,.1);border-color:#6366f1;color:#6366f1;font-weight:600}
.tm-mod-icon{display:flex;align-items:center}
.tm-mod-label{white-space:nowrap}
.tm-mod-badge{min-width:16px;height:16px;border-radius:8px;background:#6366f1;color:#fff;
  font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px}
.tm-extras-btn{background:var(--bg3);border:1px solid var(--border);color:var(--text2);
  padding:6px 12px;border-radius:var(--r2);cursor:pointer;font-size:11px;
  display:flex;align-items:center;gap:5px;width:fit-content;transition:all .12s}
.tm-extras-btn:hover{background:var(--bg4);color:var(--text)}
.tm-extras-menu{position:absolute;left:0;top:100%;margin-top:4px;background:var(--bg3);
  border:1px solid var(--border);border-radius:var(--r2);box-shadow:0 8px 24px rgba(0,0,0,.35);
  z-index:10;min-width:200px;padding:4px 0}
.tm-extras-menu-item{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:12px;
  cursor:pointer;color:var(--text2);transition:background .1s}
.tm-extras-menu-item:hover{background:var(--bg4);color:var(--text)}
.tm-extras-menu-item.active-mod{color:#6366f1;font-weight:500}
.tm-extras-menu-item.active-mod::after{content:'✓';margin-left:auto;font-size:11px}
.tm-extras-sections{margin-top:10px}

/* Sections inside extras */
@keyframes tmSectionIn{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:translateY(0)}}
.tm-section{margin-top:14px;border-top:1px solid var(--border);padding-top:10px;
  animation:tmSectionIn .18s ease both}
.tm-section h4{font-size:12px;font-weight:600;margin:0 0 6px;color:var(--text2);display:flex;align-items:center;gap:5px}
.tm-sub-item{display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px;padding:4px 6px;background:var(--bg3);border-radius:var(--r2)}
.tm-sub-item .tm-check{width:14px;height:14px}
.tm-sub-item span{flex:1}
.tm-mini-del{background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px;padding:2px}
.tm-mini-del:hover{color:#ef4444}
.tm-add-row{display:flex;gap:6px;margin-top:6px}
.tm-add-row input,.tm-add-row select{font-size:11px;padding:4px 7px}
.tm-add-row input{flex:1}
.tm-add-row button{background:var(--bg4);color:var(--text2);border:1px solid var(--border);
  padding:4px 8px;border-radius:var(--r2);cursor:pointer;font-size:11px;white-space:nowrap}
.tm-add-row button:hover{background:#6366f1;color:#fff;border-color:#6366f1}

/* Rem item */
.tm-rem-item{display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:4px;padding:4px 6px;background:var(--bg3);border-radius:var(--r2)}
.tm-rem-item span{flex:1}

/* Modal actions */
.tm-modal-actions{display:flex;gap:8px;margin-top:18px;justify-content:flex-end}
.tm-modal-actions button{padding:7px 16px;border-radius:var(--r2);font-size:12px;cursor:pointer;
  border:1px solid var(--border);transition:all .12s}
.tm-save{background:#6366f1;color:#fff;border-color:#6366f1!important;font-weight:600}
.tm-save:hover{opacity:.85}
.tm-cancel{background:var(--bg3);color:var(--text2)}
.tm-cancel:hover{background:var(--bg4);color:var(--text)}
.tm-danger{background:none;color:#ef4444;border-color:rgba(239,68,68,.3)!important;display:flex;align-items:center;gap:4px}
.tm-danger:hover{background:#ef4444;color:#fff}

/* Comments */
.tm-comment{display:flex;gap:6px;margin-bottom:8px;padding:6px 8px;background:var(--bg3);border-radius:var(--r2)}
.tm-comment-body{flex:1;min-width:0}
.tm-comment-hdr{display:flex;align-items:center;gap:5px;margin-bottom:2px}
.tm-comment-author{font-size:11px;font-weight:600;color:var(--text)}
.tm-comment-time{font-size:9px;color:var(--text3)}
.tm-comment-text{font-size:11px;color:var(--text2);white-space:pre-wrap;word-break:break-word}
.tm-comment-add{display:flex;gap:6px;margin-top:6px;align-items:flex-end}
.tm-comment-add textarea{flex:1;min-height:32px;font-size:11px;padding:6px 8px}
.tm-comment-add button{background:#6366f1;color:#fff;border:none;padding:6px 10px;
  border-radius:var(--r2);cursor:pointer;display:flex;align-items:center}
.tm-comment-add button:hover{opacity:.85}

/* Attachments */
.tm-att-item{display:flex;align-items:center;gap:6px;padding:4px 6px;background:var(--bg3);
  border-radius:var(--r2);margin-bottom:4px;font-size:11px}
.tm-att-name{font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  cursor:pointer;flex:1}
.tm-att-name:hover{color:#6366f1;text-decoration:underline}
.tm-att-size{font-size:9px;color:var(--text3)}
.tm-att-upload-btn{background:var(--bg3);color:var(--text3);border:1px dashed var(--border);
  padding:8px 12px;border-radius:var(--r2);cursor:pointer;font-size:11px;width:100%;text-align:center;
  transition:all .12s;display:flex;align-items:center;justify-content:center;gap:5px;margin-top:6px}
.tm-att-upload-btn:hover{border-color:#6366f1;color:#6366f1}
.tm-att-upload-btn.uploading{opacity:.5;pointer-events:none}

/* Confirm dialog */
.tm-confirm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9100;display:flex;
  align-items:center;justify-content:center;animation:tmFade .12s}
.tm-confirm{background:var(--bg2);border:1px solid var(--border);border-radius:12px;
  padding:24px;width:360px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.5);text-align:center}
.tm-confirm p{margin:0 0 18px;font-size:13px;color:var(--text)}
.tm-confirm-actions{display:flex;gap:8px;justify-content:center}
.tm-confirm-actions button{padding:7px 18px;border-radius:var(--r2);font-size:12px;cursor:pointer;border:1px solid var(--border)}
.tm-confirm-yes{background:#ef4444;color:#fff;border-color:#ef4444!important;font-weight:600}
.tm-confirm-yes:hover{opacity:.85}
.tm-confirm-no{background:var(--bg3);color:var(--text2)}
.tm-confirm-no:hover{background:var(--bg4)}

/* Autocomplete */
.tm-ac{position:absolute;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2);
  max-height:140px;overflow-y:auto;z-index:9999;min-width:180px;box-shadow:0 6px 20px rgba(0,0,0,.4)}
.tm-ac-item{padding:5px 8px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:6px}
.tm-ac-item:hover,.tm-ac-item.active{background:#6366f1;color:#fff}
.tm-mention{color:#6366f1;font-weight:500;cursor:default}
.tm-article-link{color:#f59e0b;font-weight:600;cursor:pointer;text-decoration:underline;
  text-decoration-style:dashed;text-underline-offset:2px;transition:all .15s;
  background:rgba(245,158,11,.08);padding:1px 4px;border-radius:3px}
.tm-article-link:hover{background:rgba(245,158,11,.18);opacity:1;text-decoration-style:solid}
.tm-desc-preview{font-size:10px;color:var(--text3);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}

/* Product popup */
.tm-product-popup{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9500;display:flex;
  align-items:center;justify-content:center}
.tm-product-popup-inner{background:var(--bg2);border:1px solid var(--border);border-radius:12px;
  width:400px;max-width:90vw;max-height:80vh;overflow-y:auto;padding:18px;box-shadow:0 16px 40px rgba(0,0,0,.5)}
.tm-product-popup-inner h4{margin:0 0 12px;font-size:15px;font-weight:600}
.tm-product-popup-inner table{width:100%;border-collapse:collapse;font-size:11px}
.tm-product-popup-inner td{padding:3px 6px;border-bottom:1px solid var(--border);vertical-align:top}
.tm-product-popup-inner td:first-child{color:var(--text3);white-space:nowrap;width:40%}
.tm-pp-close{background:var(--bg3);color:var(--text2);border:1px solid var(--border);
  padding:5px 12px;border-radius:var(--r2);cursor:pointer;font-size:11px;margin-top:10px}
.tm-pp-close:hover{background:var(--bg4)}

/* Tags chip system */
.tm-tags-wrap{margin-bottom:2px}
.tm-tags-list{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;min-height:8px}
.tm-tag-chip{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:500}
.tm-tag-remove{background:none;border:none;color:inherit;cursor:pointer;font-size:13px;padding:0 0 0 2px;opacity:.6;line-height:1}
.tm-tag-remove:hover{opacity:1}
.tm-tag-add-row{display:flex;gap:6px;align-items:center;position:relative}
.tm-tag-input{flex:1;background:var(--bg3);color:var(--text);border:1px solid var(--border);
  padding:5px 8px;border-radius:var(--r2);font-size:11px}
.tm-tag-input:focus{outline:none;border-color:#6366f1}
.tm-tag-add-btn{background:#6366f1;color:#fff;border:none;width:26px;height:26px;border-radius:50%;
  cursor:pointer;font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.tm-tag-add-btn:hover{opacity:.85}
.tm-tag-suggestions{position:absolute;left:0;top:100%;margin-top:2px;background:var(--bg3);
  border:1px solid var(--border);border-radius:var(--r2);box-shadow:0 6px 16px rgba(0,0,0,.35);
  z-index:10;min-width:160px;max-height:150px;overflow-y:auto}
.tm-tag-suggestion{padding:5px 8px;font-size:11px;cursor:pointer;color:var(--text2);transition:background .1s}
.tm-tag-suggestion:hover{background:var(--bg4);color:var(--text)}

/* Empty */
.tm-empty{text-align:center;padding:50px 20px;color:var(--text3);font-size:13px}
.tm-empty svg{opacity:.2;margin-bottom:10px}
</style>`;
  }

  // ── Toolbar ─────────────────────────────────────────────────────────────

  private renderToolbar(): string {
    const vb = (v: ViewMode, icon: string, label: string) =>
      `<button class="tm-view-btn${this.view === v ? ' active' : ''}" data-view="${v}">${icon} ${label}</button>`;
    return `
    <div class="tm-toolbar">
      <span class="tm-title">Задачи</span>
      <div class="tm-search-wrap">${IC.search}<input class="tm-search" placeholder="Поиск..." value="${esc(this.searchQ)}" data-search></div>
      <div class="tm-filters">
        <select data-filter-priority>
          <option value="all"${this.filterPriority === 'all' ? ' selected' : ''}>Все</option>
          ${(['red','yellow','blue','none'] as Priority[]).map(p =>
            `<option value="${p}"${this.filterPriority === p ? ' selected' : ''}>${esc(PRIORITY_LABEL[p])}</option>`
          ).join('')}
        </select>
        <select data-filter-status>
          <option value="all"${this.filterStatus === 'all' ? ' selected' : ''}>Все</option>
          ${STATUS_COLS.map(s =>
            `<option value="${s}"${this.filterStatus === s ? ' selected' : ''}>${esc(STATUS_LABEL[s])}</option>`
          ).join('')}
        </select>
      </div>
      ${vb('list', IC.list, 'Список')}
      ${vb('kanban', IC.kanban, 'Канбан')}
      ${vb('calendar', IC.calendar, 'Календарь')}
      ${vb('eisenhower', IC.matrix, 'Матрица')}
      <button class="tm-add-btn" data-add>${IC.plus} Задача</button>
    </div>`;
  }

  // ── LIST VIEW ───────────────────────────────────────────────────────────

  private renderListItem(t: Task, isSub: boolean): string {
    const isDone = t.status === 'done';
    const tags = t.tags ? t.tags.split(',').map(tg => { const s = tg.trim(); if (!s) return ''; const c = this.getTagColor(s); return `<span class="tm-tag" style="background:${c}20;color:${c};border:1px solid ${c}40">${esc(s)}</span>`; }).join('') : '';
    const ed = this.effectiveDueDate(t);
    const dateMeta = ed ? `<span>${IC.clock} ${fmtDate(ed)}${this.effectiveAllDay(t) ? '' : ' ' + fmtTime(this.effectiveDueTime(t))}</span>` : '';
    const assignee = t.assignee_id ? `<span style="display:flex;align-items:center;gap:2px">${this.memberAvatar(t.assignee_id, 14)} ${esc(this.memberShortName(t.assignee_id))}</span>` : '';
    const subs = this.subtasksOf(t.id);
    const subMeta = subs.length ? `<span>${IC.subtask} ${subs.filter(s => s.status === 'done').length}/${subs.length}</span>` : '';
    const prioColor = PRIORITY_COLOR[t.priority];
    const shortId = t.id.slice(0, 6).toUpperCase();
    const createdDate = t.created_at ? fmtDate(t.created_at.slice(0, 10)) : '';

    return `
    <div class="tm-list-row${isDone ? ' done' : ''}${isSub ? ' sub' : ''}" data-task-id="${t.id}">
      <div class="tm-prio-bar" style="background:${isSub ? 'transparent' : prioColor}"></div>
      <div class="tm-check${isDone ? ' checked' : ''}" data-toggle="${t.id}">${isDone ? IC.check : ''}</div>
      <div class="tm-row-body" data-edit="${t.id}">
        <div class="tm-row-title" style="display:flex;align-items:center;gap:4px;white-space:normal;overflow:visible">
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${isSub ? '' : priorityDot(t.priority) + ' '}${esc(t.title)}</span>${copyButton(t.title, 'Копировать название')}
        </div>
        ${t.description ? `<div class="tm-desc-preview">${renderRichText(t.description.substring(0, 80))}</div>` : ''}
        <div class="tm-row-meta">${dateMeta}${tags}${assignee}${subMeta}</div>
        ${!isSub && createdDate ? `<div class="tm-row-info" style="display:flex;align-items:center;gap:4px">#${shortId}${copyButton(shortId, 'Копировать ID')} · ${createdDate}</div>` : ''}
      </div>
      <button class="tm-del-btn" data-del="${t.id}" title="Удалить">${IC.trash}</button>
    </div>`;
  }

  private renderList(): string {
    const items = this.sorted(this.topLevel(this.filtered));
    const active = items.filter(t => t.status !== 'done');
    const completed = items.filter(t => t.status === 'done');

    let activeHtml = '';
    for (const t of active) {
      let group = this.renderListItem(t, false);
      for (const s of this.subtasksOf(t.id)) group += this.renderListItem(s, true);
      activeHtml += `<div class="tm-list-group">${group}</div>`;
    }
    const filteredIds = new Set(items.map(x => x.id));
    const orphans = this.filtered.filter(t => t.parent_id && !filteredIds.has(t.parent_id) && t.status !== 'done');
    for (const s of orphans) activeHtml += `<div class="tm-list-group">${this.renderListItem(s, true)}</div>`;

    let completedHtml = '';
    for (const t of completed) {
      let group = this.renderListItem(t, false);
      for (const s of this.subtasksOf(t.id)) group += this.renderListItem(s, true);
      completedHtml += `<div class="tm-list-group">${group}</div>`;
    }

    const completedSection = completed.length ? `
      <div class="tm-completed-hdr${this.completedCollapsed ? '' : ' open'}" data-toggle-completed>
        ${IC.chevron} Завершённые (${completed.length})
      </div>
      <div style="display:${this.completedCollapsed ? 'none' : 'block'}" data-completed-list>${completedHtml}</div>
    ` : '';

    return `
    <div class="tm-quick"><input placeholder="Быстрое добавление... (Enter)" data-quick-add></div>
    ${activeHtml || (completed.length ? '' : `<div class="tm-empty">${IC.list}<br>Нет задач</div>`)}
    ${completedSection}`;
  }

  // ── KANBAN VIEW ─────────────────────────────────────────────────────────

  private renderKanban(): string {
    const cols = STATUS_COLS.map(status => {
      const items = this.sorted(this.topLevel(this.filtered).filter(t => t.status === status));
      const cards = items.map(t => {
        const subCount = this.subtasksOf(t.id).length;
        const subDone = this.subtasksOf(t.id).filter(s => s.status === 'done').length;
        const assignee = this.memberAvatar(t.assignee_id, 16);
        return `
        <div class="tm-kb-card" draggable="true" data-drag-id="${t.id}" data-edit="${t.id}"
          style="border-left-color:${PRIORITY_COLOR[t.priority]}">
          <div class="tm-kb-card-title" style="display:flex;align-items:center;gap:4px;min-width:0"><span style="min-width:0">${priorityDot(t.priority)} ${esc(t.title)}</span>${copyButton(t.title, 'Копировать название')}</div>
          <div class="tm-kb-card-meta">
            ${t.scheduled_date ? `<span title="Дата выполнения">${IC.deadline} ${fmtDate(t.scheduled_date)}</span>` : ''}
            ${t.due_date ? `<span title="Дедлайн">${IC.clock} ${fmtDate(t.due_date)}</span>` : ''}
            ${subCount ? `<span>${IC.subtask} ${subDone}/${subCount}</span>` : ''}
            ${assignee}
          </div>
        </div>`;
      }).join('');
      return `
      <div class="tm-kb-col" data-col-status="${status}">
        <div class="tm-kb-hdr">${esc(STATUS_LABEL[status])} <span class="tm-kb-count">${items.length}</span></div>
        ${cards}
        <div class="tm-kb-quick"><input placeholder="+ Добавить..." data-kb-quick="${status}"></div>
      </div>`;
    }).join('');
    return `<div class="tm-kanban">${cols}</div>`;
  }

  // ── EISENHOWER ──────────────────────────────────────────────────────────

  private renderEisenhower(): string {
    const items = this.topLevel(this.filtered).filter(t => t.status !== 'done');
    const buckets: Record<EQKey, Task[]> = { ui: [], ni: [], un: [], nn: [] };
    for (const t of items) buckets[classifyEisenhower(t)].push(t);

    const quads = EISENHOWER_QUADRANTS.map(q => {
      const list = buckets[q.key];
      const cards = list.map(t => `
        <div class="tm-eq-card" draggable="true" data-drag-id="${t.id}" data-edit="${t.id}">
          <div class="tm-eq-card-title" style="display:flex;align-items:center;gap:4px;min-width:0"><span style="min-width:0">${priorityDot(t.priority)} ${esc(t.title)}</span>${copyButton(t.title, 'Копировать название')}</div>
          <div class="tm-eq-card-meta">
            ${t.due_date ? `<span>${fmtDate(t.due_date)}</span>` : ''}
            ${this.memberAvatar(t.assignee_id, 14)}
          </div>
        </div>`).join('');
      return `
      <div class="tm-eq" data-eq="${q.key}" style="border-top:3px solid ${q.color}">
        <div class="tm-eq-hdr">
          <span style="width:8px;height:8px;border-radius:50%;background:${q.color};display:inline-block"></span>
          ${esc(q.label)}
          <span class="tm-eq-count">${list.length}</span>
        </div>
        ${cards}
      </div>`;
    }).join('');
    return `<div class="tm-eisenhower">${quads}</div>`;
  }

  // ── CALENDAR ────────────────────────────────────────────────────────────

  private renderCalendar(): string {
    const toolbar = this.renderCalToolbar();
    if (this.calScope === 'month') return toolbar + this.renderCalMonth();
    if (this.calScope === 'week') return toolbar + this.renderCalWeek();
    return toolbar + this.renderCalDay();
  }

  private renderCalToolbar(): string {
    const sb = (s: CalendarScope, l: string) =>
      `<button class="tm-cal-scope-btn${this.calScope === s ? ' active' : ''}" data-cal-scope="${s}">${l}</button>`;
    let title = '';
    if (this.calScope === 'month') {
      title = `${MONTH_NAMES_RU[this.calDate.getMonth()]} ${this.calDate.getFullYear()}`;
    } else if (this.calScope === 'week') {
      const mon = this.getWeekStart(this.calDate);
      const sun = new Date(mon); sun.setDate(sun.getDate() + 6);
      title = `${pad(mon.getDate())}.${pad(mon.getMonth()+1)} — ${pad(sun.getDate())}.${pad(sun.getMonth()+1)}.${sun.getFullYear()}`;
    } else {
      title = `${pad(this.calDate.getDate())} ${MONTH_NAMES_RU[this.calDate.getMonth()]} ${this.calDate.getFullYear()}`;
    }
    return `
    <div class="tm-cal-toolbar">
      <button class="tm-cal-nav" data-cal-prev>${IC.left}</button>
      <button class="tm-cal-nav" data-cal-today>Сегодня</button>
      <button class="tm-cal-nav" data-cal-next>${IC.right}</button>
      <span class="tm-cal-title">${title}</span>
      <span style="margin-left:auto"></span>
      ${sb('month', 'Месяц')} ${sb('week', 'Неделя')} ${sb('day', 'День')}
    </div>`;
  }

  private getWeekStart(d: Date): Date { const r = new Date(d); r.setDate(r.getDate() - dayOfWeekMon(r)); return r; }

  /** Tasks for a date. excludeSubs=true hides subtasks (for month view compact display) */
  private tasksForDate(iso: string, excludeSubs = false): Task[] {
    return this.tasks.filter(t => {
      if (excludeSubs && t.parent_id) return false;
      const dd = this.effectiveDueDate(t);
      return dd === iso;
    });
  }

  private calTaskColor(t: Task): string {
    return PRIORITY_COLOR[t.priority] === 'transparent' ? '#64748b' : PRIORITY_COLOR[t.priority];
  }

  /** Check if a task shows as all-day in calendar (uses effective values) */
  private isCalAllDay(t: Task): boolean {
    return this.effectiveAllDay(t) || !this.effectiveDueTime(t);
  }

  /** Render a rich task label for calendar cells (priority dot, title, subtask count, assignee, end time) */
  private calTaskLabel(t: Task, showTime = false): string {
    const parts: string[] = [];
    if (showTime) parts.push(fmtTime(this.effectiveDueTime(t)));
    if (t.end_time) parts.push(`-${fmtTime(t.end_time)}`);
    parts.push(esc(t.title));
    const sc = !t.parent_id ? this.subtasksOf(t.id).length : 0;
    if (sc) parts.push(`<span style="opacity:.5">(+${sc})</span>`);
    const assignee = this.memberShortName(t.assignee_id);
    if (assignee) parts.push(`<span style="opacity:.5;font-size:8px">· ${esc(assignee)}</span>`);
    return `${priorityDot(t.priority, 6)} ${parts.join(' ')}`;
  }

  private renderCalMonth(): string {
    const year = this.calDate.getFullYear();
    const month = this.calDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const startOff = dayOfWeekMon(firstDay);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayISO = toISO(new Date());

    let html = '<div class="tm-cal-grid">';
    html += '<div class="tm-cal-hdr" style="font-size:9px;color:var(--text3)">Нед</div>';
    html += DAY_NAMES_RU.map(d => `<div class="tm-cal-hdr">${d}</div>`).join('');

    const start = new Date(firstDay); start.setDate(start.getDate() - startOff);
    const totalCells = Math.ceil((startOff + daysInMonth) / 7) * 7;
    for (let i = 0; i < totalCells; i++) {
      const cellDate = new Date(start); cellDate.setDate(start.getDate() + i);
      const iso = toISO(cellDate);
      const isOther = cellDate.getMonth() !== month;
      const isToday = iso === todayISO;

      if (i % 7 === 0) html += `<div class="tm-cal-wk">${weekNumber(cellDate)}</div>`;

      const dayTasks = this.tasksForDate(iso, true); // exclude subtasks in month
      const allDay = dayTasks.filter(t => this.isCalAllDay(t));
      const timed = dayTasks.filter(t => !this.isCalAllDay(t));
      // Show subtask count inline
      let inner = `<div class="tm-cal-day">${cellDate.getDate()}</div>`;
      for (const t of allDay.slice(0, 3)) {
        const sc = this.subtasksOf(t.id).length;
        inner += `<div class="tm-cal-allday tm-cal-task" style="border-color:${this.calTaskColor(t)}" data-edit="${t.id}">${esc(t.title)}${sc ? ` <span style="opacity:.5">(+${sc})</span>` : ''}</div>`;
      }
      for (const t of timed.slice(0, 3)) {
        const sc = this.subtasksOf(t.id).length;
        inner += `<div class="tm-cal-task" style="background:${this.calTaskColor(t)}" data-edit="${t.id}">${fmtTime(this.effectiveDueTime(t))} ${esc(t.title)}${sc ? ` (+${sc})` : ''}</div>`;
      }
      const overflow = dayTasks.length - 6;
      if (overflow > 0) inner += `<div style="font-size:8px;color:var(--text3)">+${overflow}</div>`;

      html += `<div class="tm-cal-cell${isToday ? ' today' : ''}${isOther ? ' other' : ''}">${inner}</div>`;
    }
    html += '</div>';

    // Задачи без даты — показываем внизу
    const undated = this.topLevel(this.tasks).filter(t => !this.effectiveDueDate(t) && t.status !== 'done');
    if (undated.length > 0) {
      html += `<div style="margin-top:12px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2)">
        <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:8px;display:flex;align-items:center;gap:6px">
          ${IC.clock} Без даты <span style="font-weight:400;color:var(--text3)">(${undated.length})</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${undated.map(t => `
            <div class="tm-cal-allday tm-cal-task" style="border-color:${this.calTaskColor(t)};display:inline-flex;align-items:center;gap:4px;cursor:pointer;padding:3px 8px;font-size:10px" data-edit="${t.id}">
              ${priorityDot(t.priority, 5)} ${esc(t.title)}
            </div>
          `).join('')}
        </div>
      </div>`;
    }

    return html;
  }

  private renderCalWeek(): string {
    const mon = this.getWeekStart(this.calDate);
    const todayISO = toISO(new Date());
    let html = '<div class="tm-cal-week-grid"><div class="tm-cal-hdr"></div>';
    for (let d = 0; d < 7; d++) {
      const dt = new Date(mon); dt.setDate(mon.getDate() + d);
      const iso = toISO(dt); const isT = iso === todayISO;
      html += `<div class="tm-cal-hdr"${isT ? ' style="color:#6366f1"' : ''}>${DAY_NAMES_RU[d]} ${dt.getDate()}</div>`;
    }
    html += '<div class="tm-cal-hour" style="height:auto;min-height:24px;font-size:9px">Весь день</div>';
    for (let d = 0; d < 7; d++) {
      const dt = new Date(mon); dt.setDate(mon.getDate() + d);
      const iso = toISO(dt);
      const ad = this.tasksForDate(iso).filter(t => this.isCalAllDay(t));
      let cell = '';
      for (const t of ad)
        cell += `<div class="tm-cal-allday tm-cal-task" style="border-color:${this.calTaskColor(t)};position:relative" data-edit="${t.id}">${this.calTaskLabel(t)}</div>`;
      html += `<div class="tm-cal-hour-cell" style="height:auto;min-height:24px">${cell}</div>`;
    }
    for (let h = 0; h < 24; h++) {
      html += `<div class="tm-cal-hour">${pad(h)}:00</div>`;
      for (let d = 0; d < 7; d++) {
        const dt = new Date(mon); dt.setDate(mon.getDate() + d);
        const iso = toISO(dt); const isT = iso === todayISO;
        const hourTasks = this.tasksForDate(iso).filter(t => {
          if (this.isCalAllDay(t)) return false;
          const time = this.effectiveDueTime(t);
          return time ? parseInt(time.split(':')[0], 10) === h : false;
        });
        let cell = '';
        for (const t of hourTasks)
          cell += `<div class="tm-cal-time-task" style="background:${this.calTaskColor(t)};top:1px" data-edit="${t.id}">${this.calTaskLabel(t, true)}</div>`;
        html += `<div class="tm-cal-hour-cell${isT ? ' today-col' : ''}">${cell}</div>`;
      }
    }
    html += '</div>';
    return html;
  }

  private renderCalDay(): string {
    const iso = toISO(this.calDate);
    const todayISO = toISO(new Date());
    const isToday = iso === todayISO;
    const ad = this.tasksForDate(iso).filter(t => this.isCalAllDay(t));
    let html = '<div class="tm-cal-day-grid">';
    html += '<div class="tm-cal-hour" style="height:auto;min-height:24px;font-size:9px">Весь день</div>';
    let adC = '';
    for (const t of ad)
      adC += `<div class="tm-cal-allday tm-cal-task" style="border-color:${this.calTaskColor(t)};position:relative" data-edit="${t.id}">${this.calTaskLabel(t)}</div>`;
    html += `<div class="tm-cal-hour-cell" style="height:auto;min-height:24px">${adC}</div>`;
    for (let h = 0; h < 24; h++) {
      html += `<div class="tm-cal-hour">${pad(h)}:00</div>`;
      const hourTasks = this.tasksForDate(iso).filter(t => {
        if (this.isCalAllDay(t)) return false;
        const time = this.effectiveDueTime(t);
        return time ? parseInt(time.split(':')[0], 10) === h : false;
      });
      let cell = '';
      for (const t of hourTasks)
        cell += `<div class="tm-cal-time-task" style="background:${this.calTaskColor(t)};top:1px" data-edit="${t.id}">${this.calTaskLabel(t, true)}</div>`;
      html += `<div class="tm-cal-hour-cell${isToday ? ' today-col' : ''}">${cell}</div>`;
    }
    html += '</div>';
    return html;
  }

  // ── MODAL ───────────────────────────────────────────────────────────────

  private renderModal(): string {
    const t = this.editingTask!;
    const isNew = !this.tasks.find(x => x.id === t.id);
    const taskReminders = this.reminders.filter(r => r.task_id === t.id);
    const subtasks = this.subtasksOf(t.id);
    const isSubtask = !!t.parent_id;

    const memberOptions = this.members.map(m => {
      let label = m.first_name || '';
      if (m.telegram_username) label += label ? ` (@${m.telegram_username})` : `@${m.telegram_username}`;
      if (!label) label = m.user_id.slice(0, 8);
      return `<option value="${m.user_id}"${t.assignee_id === m.user_id ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');

    const subList = subtasks.map(s => {
      const isDone = s.status === 'done';
      return `<div class="tm-sub-item">
        <div class="tm-check${isDone ? ' checked' : ''}" data-sub-toggle="${s.id}" style="width:14px;height:14px">${isDone ? IC.check : ''}</div>
        <span style="${isDone ? 'text-decoration:line-through;opacity:.5' : ''}">${esc(s.title)}</span>
        <button class="tm-mini-del" data-sub-del="${s.id}">&times;</button>
      </div>`;
    }).join('');

    const remList = taskReminders.map(r => `
      <div class="tm-rem-item">
        <span>${IC.bell} ${esc(r.title)} — ${new Date(r.remind_at).toLocaleString('ru')} (${r.repeat === 'none' ? 'однократно' : r.repeat})</span>
        <button class="tm-mini-del" data-rem-del="${r.id}">&times;</button>
      </div>`).join('');

    // Extras: modular toggle cards — always show for non-subtask tasks.
    // For brand-new unsaved tasks the module buttons are shown but clicking
    // them triggers an auto-save first (handled in bindModal).
    const hasExtras = !isSubtask;
    const modCard = (key: string, icon: string, label: string, active: boolean, count: number) =>
      `<button class="tm-mod-card${active ? ' active' : ''}" data-toggle-module="${key}" title="${label}">
        <span class="tm-mod-icon">${icon}</span>
        <span class="tm-mod-label">${label}</span>
        ${count > 0 ? `<span class="tm-mod-badge">${count}</span>` : ''}
      </button>`;
    const extrasContent = hasExtras ? `
      <div class="tm-extras-wrap">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:6px">Модули</div>
        <div class="tm-mod-cards">
          ${modCard('subs', IC.subtask, 'Подзадачи', this.modalShowSubs, subtasks.length)}
          ${modCard('date', IC.deadline, 'Дата', this.modalShowDate, t.scheduled_date ? 1 : 0)}
          ${modCard('deadline', IC.deadline, 'Дедлайн', this.modalShowDeadline, t.due_date ? 1 : 0)}
          ${modCard('reminders', IC.bell, 'Напоминания', this.modalShowReminders, taskReminders.length)}
          ${modCard('files', IC.attach, 'Файлы', this.modalShowFiles, this.editAttachments.length)}
          ${modCard('comments', IC.comment, 'Комментарии', this.modalShowComments, this.editComments.length)}
        </div>
      </div>
      <div class="tm-extras-sections">
        ${this.modalShowDate ? `
        <div class="tm-section">
          <h4>${IC.deadline} Дата выполнения</h4>
          <div class="tm-modal-row">
            <div>
              <label>Когда делаю</label>
              <input type="date" data-f="scheduled_date" value="${t.scheduled_date || ''}">
            </div>
          </div>
        </div>` : ''}
        ${this.modalShowDeadline ? `
        <div class="tm-section">
          <h4>${IC.deadline} Дедлайн</h4>
          <div class="tm-modal-row">
            <div>
              <label>До какого числа</label>
              <input type="date" data-f="due_date" value="${t.due_date || ''}">
            </div>
            <div>
              <label>Начало</label>
              <input type="time" data-f="due_time" value="${t.due_time || ''}"${t.all_day ? ' disabled' : ''}>
            </div>
            <div>
              <label>Конец</label>
              <input type="time" data-f="end_time" value="${t.end_time || ''}"${t.all_day ? ' disabled' : ''}>
            </div>
          </div>
          <div class="tm-allday-row" style="margin-top:8px">
            <label class="tm-toggle"><input type="checkbox" data-f="all_day"${t.all_day ? ' checked' : ''}><span></span></label>
            <label style="margin:0;cursor:pointer;font-size:11px;text-transform:none;letter-spacing:0">Весь день</label>
          </div>
        </div>` : ''}
        ${this.modalShowSubs ? `
        <div class="tm-section">
          <h4>${IC.subtask} Подзадачи</h4>
          ${subList || '<div style="font-size:11px;color:var(--text3)">Нет подзадач</div>'}
          <div class="tm-add-row">
            <input placeholder="Новая подзадача..." data-sub-input>
            <button data-sub-add-btn>Добавить</button>
          </div>
        </div>` : ''}
        ${this.modalShowReminders ? `
        <div class="tm-section">
          <h4>${IC.bell} Напоминания</h4>
          ${remList || '<div style="font-size:11px;color:var(--text3)">Нет напоминаний</div>'}
          <div class="tm-add-row">
            <input type="datetime-local" data-rem-dt>
            <select data-rem-repeat>
              <option value="none">Однократно</option>
              <option value="daily">Ежедневно</option>
              <option value="weekly">Еженедельно</option>
              <option value="monthly">Ежемесячно</option>
            </select>
            <button data-rem-add-btn>Добавить</button>
          </div>
        </div>` : ''}
        ${this.modalShowFiles ? `
        <div class="tm-section">
          <h4>${IC.attach} Файлы</h4>
          ${this.editAttachments.map(a => `
            <div class="tm-att-item">
              ${a.mime_type.startsWith('image/') ? IC.image : IC.file}
              <span class="tm-att-name" data-att-download="${a.id}" title="${esc(a.file_name)}">${esc(a.file_name)}</span>
              <span class="tm-att-size">${fmtSize(a.file_size)}</span>
              <button class="tm-mini-del" data-att-del="${a.id}" data-att-path="${esc(a.storage_path)}">&times;</button>
            </div>`).join('') || '<div style="font-size:11px;color:var(--text3)">Нет файлов</div>'}
          <input type="file" data-att-file-input style="display:none" multiple>
          <div class="tm-att-upload-btn${this.uploadingFile ? ' uploading' : ''}" data-att-upload-btn>
            ${IC.attach} ${this.uploadingFile ? 'Загрузка...' : 'Прикрепить файл'}
          </div>
        </div>` : ''}
        ${this.modalShowComments ? `
        <div class="tm-section">
          <h4>${IC.comment} Комментарии</h4>
          ${this.editComments.map(c => {
            const canDel = c.author_id === this.currentUserId;
            return `<div class="tm-comment">
              ${this.memberAvatar(c.author_id, 22)}
              <div class="tm-comment-body">
                <div class="tm-comment-hdr">
                  <span class="tm-comment-author">${esc(this.memberName(c.author_id) || 'Участник')}</span>
                  <span class="tm-comment-time">${new Date(c.created_at).toLocaleString('ru')}</span>
                </div>
                <div class="tm-comment-text">${renderRichText(c.body)}</div>
              </div>
              ${canDel ? `<button class="tm-mini-del" data-comment-del="${c.id}">&times;</button>` : ''}
            </div>`;
          }).join('') || '<div style="font-size:11px;color:var(--text3)">Нет комментариев</div>'}
          <div class="tm-comment-add">
            <textarea placeholder="Написать комментарий..." data-comment-input rows="2"></textarea>
            <button data-comment-send>${IC.send}</button>
          </div>
        </div>` : ''}
      </div>
    ` : '';

    return `
    <div class="tm-overlay${this.modalIsRefresh ? ' no-anim' : ''}" data-overlay>
      <div class="tm-modal" onclick="event.stopPropagation()">
        <h3>${isNew ? `${IC.plus} Новая задача` : 'Редактировать задачу'}</h3>

        <label>Название</label>
        <input data-f="title" value="${esc(t.title)}" placeholder="Введите название задачи">

        <label>Описание</label>
        <div style="position:relative">
          <textarea data-f="description" data-ac-target placeholder="Описание, @упоминания, /артикулы...">${esc(t.description)}</textarea>
          <div class="tm-ac" style="display:none" data-ac-list></div>
        </div>

        <div class="tm-modal-row">
          <div>
            <label>Приоритет</label>
            <input type="hidden" data-f="priority" value="${t.priority}">
            <div class="tm-prio-btns">
              ${(['blue','yellow','red'] as Priority[]).map(p =>
                `<button type="button" class="tm-prio-btn${t.priority === p ? ' active' : ''}" data-priority-btn="${p}"
                  style="border-color:${t.priority === p ? PRIORITY_COLOR[p] : 'var(--border)'}">
                  <div class="tm-prio-inner" style="background:${PRIORITY_COLOR[p]}"></div>
                  <span class="tm-prio-tip">${esc(PRIORITY_LABEL[p])}</span>
                </button>`).join('')}
            </div>
          </div>
          <div>
            <label>Статус</label>
            <select data-f="status">
              ${STATUS_COLS.map(s =>
                `<option value="${s}"${t.status === s ? ' selected' : ''}>${esc(STATUS_LABEL[s])}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Исполнитель</label>
            <select data-f="assignee_id">
              <option value=""${!t.assignee_id ? ' selected' : ''}>— Не назначен —</option>
              ${memberOptions}
            </select>
          </div>
        </div>

        <label>Теги</label>
        <div class="tm-tags-wrap">
          <div class="tm-tags-list" data-tags-list>
            ${t.tags ? t.tags.split(',').map(tg => {
              const tag = tg.trim();
              if (!tag) return '';
              const color = this.getTagColor(tag);
              return `<span class="tm-tag-chip" style="background:${color}20;border:1px solid ${color};color:${color}">
                ${esc(tag)}
                <button class="tm-tag-remove" data-tag-remove="${esc(tag)}">&times;</button>
              </span>`;
            }).join('') : ''}
          </div>
          <div class="tm-tag-add-row">
            <input placeholder="Новый тег..." data-tag-input class="tm-tag-input">
            <div class="tm-tag-suggestions" data-tag-suggestions style="display:none"></div>
            <button data-tag-add-btn class="tm-tag-add-btn">+</button>
          </div>
        </div>

        ${extrasContent}

        <div class="tm-modal-actions">
          ${!isNew ? `<button class="tm-danger" data-modal-delete>${IC.trash} Удалить</button>` : ''}
          <button class="tm-cancel" data-modal-cancel>Отмена</button>
          <button class="tm-save" data-modal-save>Сохранить</button>
        </div>
      </div>
    </div>`;
  }

  // ── Product popup ───────────────────────────────────────────────────────

  private renderProductPopup(): string {
    const p = this.productPopup!;
    const d = p.data;
    const article = d['Артикул*'] || d['Артикул'] || getArticle(p);
    const name = d['Название товара*'] || d['Название товара'] || d['Наименование'] || '';
    const price = d['Цена, руб.*'] || d['Цена'] || d['Цена, руб.'] || '';
    const photoUrl = d['Ссылка на главное фото*'] || d['Ссылка на главное фото'] || d['Фото'] || '';
    const brand = d['Бренд*'] || d['Бренд'] || '';
    const barcode = d['Баркод'] || d['Штрихкод'] || '';

    return `
    <div class="tm-product-popup" data-product-overlay>
      <div class="tm-product-popup-inner" onclick="event.stopPropagation()" style="padding:0;overflow:hidden">
        ${photoUrl ? `
        <div style="background:var(--bg3);display:flex;align-items:center;justify-content:center;height:200px;overflow:hidden">
          <img src="${esc(String(photoUrl))}" alt="${esc(String(name))}"
            style="max-width:100%;max-height:200px;object-fit:contain">
        </div>` : `
        <div style="background:var(--bg3);display:flex;align-items:center;justify-content:center;height:120px">
          <span style="font-size:40px;opacity:.15">${IC.image}</span>
        </div>`}
        <div style="padding:16px 18px">
          <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;line-height:1.3">${esc(String(name)) || 'Без названия'}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <span style="font-size:12px;color:var(--text3)">Артикул:</span>
            <span style="font-size:12px;font-weight:600;color:var(--text)">${esc(String(article))}</span>
            ${brand ? `<span style="font-size:11px;color:var(--text3);margin-left:4px">· ${esc(String(brand))}</span>` : ''}
          </div>
          ${price ? `
          <div style="font-size:20px;font-weight:700;color:#6366f1;margin-bottom:8px">${esc(String(price))} ₽</div>` : ''}
          ${barcode ? `
          <div style="font-size:10px;color:var(--text3);margin-bottom:10px">Штрихкод: ${esc(String(barcode))}</div>` : ''}
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="tm-save" data-product-goto style="flex:1;display:flex;align-items:center;justify-content:center;gap:5px;padding:8px 14px">
              ${IC.right} Перейти в товары
            </button>
            <button class="tm-cancel" data-product-close style="padding:8px 14px">Закрыть</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  private renderConfirmDialog(): string {
    return `
    <div class="tm-confirm-overlay" data-confirm-overlay>
      <div class="tm-confirm" onclick="event.stopPropagation()">
        <p>Удалить задачу и все её подзадачи?</p>
        <div class="tm-confirm-actions">
          <button class="tm-confirm-no" data-confirm-no>Отмена</button>
          <button class="tm-confirm-yes" data-confirm-yes>${IC.trash} Удалить</button>
        </div>
      </div>
    </div>`;
  }

  // ── EVENT BINDING ───────────────────────────────────────────────────────

  private bind(): void {
    const $ = (sel: string) => this.el.querySelector<HTMLElement>(sel);
    const $$ = (sel: string) => this.el.querySelectorAll<HTMLElement>(sel);

    for (const btn of $$('.tm-view-btn')) btn.addEventListener('click', () => { this.view = btn.dataset.view as ViewMode; this.render(); });
    $('[data-add]')?.addEventListener('click', () => this.openNew());

    const searchEl = $('[data-search]') as HTMLInputElement | null;
    searchEl?.addEventListener('input', () => { this.searchQ = searchEl.value; this.render(); });

    ($('[data-filter-priority]') as HTMLSelectElement | null)?.addEventListener('change', function(this: HTMLSelectElement) {
      // bound below
    });
    const fpEl = $('[data-filter-priority]') as HTMLSelectElement | null;
    fpEl?.addEventListener('change', () => { this.filterPriority = fpEl.value as Priority | 'all'; this.render(); });
    const fsEl = $('[data-filter-status]') as HTMLSelectElement | null;
    fsEl?.addEventListener('change', () => { this.filterStatus = fsEl.value as Status | 'all'; this.render(); });

    // Quick add
    const qaEl = $('[data-quick-add]') as HTMLInputElement | null;
    qaEl?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && qaEl.value.trim()) { await this.quickAdd(qaEl.value.trim()); qaEl.value = ''; }
    });

    // Toggle done
    for (const chk of $$('[data-toggle]')) chk.addEventListener('click', (e) => { e.stopPropagation(); this.toggleDone(chk.dataset.toggle!); });

    // Edit — only if no modal already open
    for (const el of $$('[data-edit]')) el.addEventListener('click', (e) => { e.stopPropagation(); if (!this.editingTask) this.openEdit(el.dataset.edit!); });

    // Delete → confirm
    for (const btn of $$('[data-del]')) btn.addEventListener('click', (e) => { e.stopPropagation(); this.confirmDeleteId = btn.dataset.del!; this.render(); });

    // Completed toggle
    $('[data-toggle-completed]')?.addEventListener('click', () => { this.completedCollapsed = !this.completedCollapsed; this.render(); });

    // Kanban quick add
    for (const input of $$('[data-kb-quick]') as any as HTMLInputElement[]) {
      input.addEventListener('keydown', async (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (input as HTMLInputElement).value.trim()) {
          await this.quickAddWithStatus((input as HTMLInputElement).value.trim(), input.dataset.kbQuick as Status);
          (input as HTMLInputElement).value = '';
        }
      });
    }

    // Confirm dialog
    $('[data-confirm-overlay]')?.addEventListener('click', () => { this.confirmDeleteId = null; this.render(); });
    $('[data-confirm-no]')?.addEventListener('click', () => { this.confirmDeleteId = null; this.render(); });
    $('[data-confirm-yes]')?.addEventListener('click', () => { if (this.confirmDeleteId) { this.deleteTask(this.confirmDeleteId); this.confirmDeleteId = null; } });

    // Calendar
    for (const btn of $$('[data-cal-scope]')) btn.addEventListener('click', () => { this.calScope = btn.dataset.calScope as CalendarScope; this.render(); });
    $('[data-cal-prev]')?.addEventListener('click', () => this.calNav(-1));
    $('[data-cal-next]')?.addEventListener('click', () => this.calNav(1));
    $('[data-cal-today]')?.addEventListener('click', () => { this.calDate = new Date(); this.render(); });

    this.bindKanbanDrag();
    this.bindEisenhowerDrag();

    // Article links — click navigates directly to products with search filter
    for (const link of $$('.tm-article-link')) {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const a = link.dataset.article;
        if (!a) return;
        this.navigateToProduct(a);
      });
    }
    $('[data-product-overlay]')?.addEventListener('click', () => { this.productPopup = null; this.render(); });
    $('[data-product-close]')?.addEventListener('click', () => { this.productPopup = null; this.render(); });
    $('[data-product-goto]')?.addEventListener('click', () => {
      if (this.productPopup) {
        const d = this.productPopup.data;
        const article = d['Артикул*'] || d['Артикул'] || getArticle(this.productPopup);
        this.navigateToProduct(String(article));
      }
    });

    this.bindModal();
  }

  // ── Kanban D&D ──────────────────────────────────────────────────────────

  private bindKanbanDrag(): void {
    const cards = this.el.querySelectorAll<HTMLElement>('.tm-kb-card[draggable]');
    const cols = this.el.querySelectorAll<HTMLElement>('.tm-kb-col');
    for (const card of cards) {
      card.addEventListener('dragstart', (e) => { this.dragTaskId = card.dataset.dragId!; card.classList.add('dragging'); e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', this.dragTaskId); });
      card.addEventListener('dragend', () => { card.classList.remove('dragging'); this.dragTaskId = null; for (const c of cols) c.classList.remove('drag-over'); });
    }
    for (const col of cols) {
      col.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; col.classList.add('drag-over'); });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault(); col.classList.remove('drag-over');
        const tid = e.dataTransfer!.getData('text/plain');
        const newStatus = col.dataset.colStatus as Status;
        if (!tid || !newStatus) return;
        const task = this.tasks.find(t => t.id === tid);
        if (!task || task.status === newStatus) return;
        task.status = newStatus;
        task.completed_at = newStatus === 'done' ? new Date().toISOString() : null;
        try { await taskDb.updateTask(tid, { status: newStatus, completed_at: task.completed_at }); } catch (err) { console.error(err); }
        this.render();
      });
    }
  }

  // ── Eisenhower D&D ──────────────────────────────────────────────────────

  private bindEisenhowerDrag(): void {
    const cards = this.el.querySelectorAll<HTMLElement>('.tm-eq-card[draggable]');
    const quads = this.el.querySelectorAll<HTMLElement>('.tm-eq');
    for (const card of cards) {
      card.addEventListener('dragstart', (e) => { this.dragTaskId = card.dataset.dragId!; card.classList.add('dragging'); e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', this.dragTaskId); });
      card.addEventListener('dragend', () => { card.classList.remove('dragging'); this.dragTaskId = null; for (const q of quads) q.classList.remove('drag-over'); });
    }
    for (const quad of quads) {
      quad.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; quad.classList.add('drag-over'); });
      quad.addEventListener('dragleave', () => quad.classList.remove('drag-over'));
      quad.addEventListener('drop', async (e) => {
        e.preventDefault(); quad.classList.remove('drag-over');
        const tid = e.dataTransfer!.getData('text/plain');
        const targetQ = quad.dataset.eq as EQKey;
        if (!tid || !targetQ) return;
        const task = this.tasks.find(t => t.id === tid);
        if (!task) return;
        const updates: TaskUpdate = {};
        const today = toISO(new Date());
        switch (targetQ) {
          case 'ui': updates.priority = 'red'; if (!task.due_date || task.due_date > today) updates.due_date = today; break;
          case 'ni': updates.priority = 'blue'; break;
          case 'un': updates.priority = 'yellow'; if (!task.due_date || task.due_date > today) updates.due_date = today; break;
          case 'nn': updates.priority = 'none'; break;
        }
        Object.assign(task, updates);
        try { await taskDb.updateTask(tid, updates); } catch (err) { console.error(err); }
        this.render();
      });
    }
  }

  // ── Modal bindings ──────────────────────────────────────────────────────

  private bindModal(): void {
    if (!this.editingTask) return;
    const $ = (sel: string) => this.el.querySelector<HTMLElement>(sel);
    const $$ = (sel: string) => this.el.querySelectorAll<HTMLElement>(sel);

    $('[data-overlay]')?.addEventListener('click', () => { this.editingTask = null; this.resetModalFlags(); this.render(); });

    // All-day toggle — disable/enable both start and end time
    const adCheck = $('[data-f="all_day"]') as HTMLInputElement | null;
    const timeIn = $('[data-f="due_time"]') as HTMLInputElement | null;
    const endTimeIn = $('[data-f="end_time"]') as HTMLInputElement | null;
    adCheck?.addEventListener('change', () => {
      if (timeIn) timeIn.disabled = adCheck.checked;
      if (endTimeIn) endTimeIn.disabled = adCheck.checked;
    });

    // Priority toggles
    for (const btn of $$('[data-priority-btn]')) {
      btn.addEventListener('click', () => {
        const p = btn.dataset.priorityBtn as Priority;
        const hidden = $('[data-f="priority"]') as HTMLInputElement | null;
        if (!hidden) return;
        const newVal = hidden.value === p ? 'none' : p;
        hidden.value = newVal;
        for (const b of $$('[data-priority-btn]')) {
          const bp = b.dataset.priorityBtn as Priority;
          b.classList.toggle('active', bp === newVal);
          (b as HTMLElement).style.borderColor = bp === newVal ? PRIORITY_COLOR[bp] : 'var(--border)';
        }
      });
    }

    // Toggle module cards — if task is new (not yet in DB), auto-save first
    for (const item of $$('[data-toggle-module]')) {
      item.addEventListener('click', async () => {
        const mod = item.dataset.toggleModule as string;

        // Auto-save new task before opening a module that requires a DB record
        const isUnsaved = this.editingTask && !this.tasks.find(x => x.id === this.editingTask!.id);
        if (isUnsaved) {
          await this.saveModalKeepOpen();
          if (!this.editingTask) return; // save failed or modal was closed
        }

        if (mod === 'subs') this.modalShowSubs = !this.modalShowSubs;
        else if (mod === 'date') this.modalShowDate = !this.modalShowDate;
        else if (mod === 'deadline') this.modalShowDeadline = !this.modalShowDeadline;
        else if (mod === 'reminders') this.modalShowReminders = !this.modalShowReminders;
        else if (mod === 'files') this.modalShowFiles = !this.modalShowFiles;
        else if (mod === 'comments') this.modalShowComments = !this.modalShowComments;
        this.render();
      });
    }

    // Tags chip management
    const tagInput = $('[data-tag-input]') as HTMLInputElement | null;
    const tagSuggestions = $('[data-tag-suggestions]') as HTMLElement | null;
    $('[data-tag-add-btn]')?.addEventListener('click', () => {
      if (tagInput?.value.trim() && this.editingTask) {
        this.addTagToEditing(tagInput.value.trim());
        tagInput.value = '';
        if (tagSuggestions) tagSuggestions.style.display = 'none';
      }
    });
    tagInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (tagInput.value.trim() && this.editingTask) {
          this.addTagToEditing(tagInput.value.trim());
          tagInput.value = '';
          if (tagSuggestions) tagSuggestions.style.display = 'none';
        }
      }
    });
    tagInput?.addEventListener('input', () => {
      if (!tagSuggestions) return;
      const q = tagInput.value.trim().toLowerCase();
      if (!q) { tagSuggestions.style.display = 'none'; return; }
      const existing = this.getAllExistingTags().filter(t => t.toLowerCase().includes(q) && !this.editingTaskTags().includes(t));
      if (!existing.length) { tagSuggestions.style.display = 'none'; return; }
      tagSuggestions.style.display = '';
      tagSuggestions.innerHTML = existing.slice(0, 6).map(t =>
        `<div class="tm-tag-suggestion" data-tag-pick="${esc(t)}" style="border-left:3px solid ${this.getTagColor(t)}">${esc(t)}</div>`
      ).join('');
      for (const el of tagSuggestions.querySelectorAll<HTMLElement>('[data-tag-pick]')) {
        el.addEventListener('click', () => {
          this.addTagToEditing(el.dataset.tagPick!);
          tagInput.value = '';
          tagSuggestions.style.display = 'none';
        });
      }
    });
    for (const btn of $$('[data-tag-remove]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeTagFromEditing(btn.dataset.tagRemove!);
      });
    }

    $('[data-modal-save]')?.addEventListener('click', () => this.saveModal());
    $('[data-modal-cancel]')?.addEventListener('click', () => { this.editingTask = null; this.resetModalFlags(); this.render(); });
    $('[data-modal-delete]')?.addEventListener('click', () => { if (this.editingTask) { this.confirmDeleteId = this.editingTask.id; this.render(); } });

    // Reminder delete
    for (const btn of $$('[data-rem-del]')) btn.addEventListener('click', async () => {
      try { await reminderDb.deleteReminder(btn.dataset.remDel!); this.reminders = this.reminders.filter(r => r.id !== btn.dataset.remDel); this.render(); } catch (err) { console.error(err); }
    });
    // Reminder add
    $('[data-rem-add-btn]')?.addEventListener('click', async () => {
      const dtEl = $('[data-rem-dt]') as HTMLInputElement | null;
      const repEl = $('[data-rem-repeat]') as HTMLSelectElement | null;
      if (!dtEl?.value || !this.editingTask) return;
      try {
        const rem = await reminderDb.createReminder({ task_id: this.editingTask.id, title: this.editingTask.title, remind_at: new Date(dtEl.value).toISOString(), repeat: (repEl?.value || 'none') as Reminder['repeat'], dismissed: false });
        this.reminders.push(rem); this.render();
      } catch (err) { console.error(err); }
    });

    // Subtask toggle/delete/add
    for (const chk of $$('[data-sub-toggle]')) chk.addEventListener('click', async () => { await this.toggleDone(chk.dataset.subToggle!); });
    for (const btn of $$('[data-sub-del]')) btn.addEventListener('click', async () => { await this.deleteTask(btn.dataset.subDel!); });
    $('[data-sub-add-btn]')?.addEventListener('click', async () => {
      const input = $('[data-sub-input]') as HTMLInputElement | null;
      if (!input?.value.trim() || !this.editingTask) return;
      const parent = this.editingTask;
      try {
        const created = await taskDb.createTask({
          title: input.value.trim(), description: '', status: 'todo',
          priority: parent.priority,
          scheduled_date: parent.scheduled_date,
          due_date: parent.due_date, due_time: parent.due_time,
          end_time: parent.end_time,
          all_day: parent.all_day,
          tags: '', sort_order: this.tasks.length,
          parent_id: parent.id, assignee_id: null,
        });
        this.tasks.push(created); this.render();
      } catch (err) { console.error(err); }
    });

    // Attachment bindings
    $('[data-att-upload-btn]')?.addEventListener('click', () => { ($('[data-att-file-input]') as HTMLInputElement)?.click(); });
    ($('[data-att-file-input]') as HTMLInputElement)?.addEventListener('change', async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files?.length || !this.editingTask) return;
      const taskId = this.editingTask.id;
      this.uploadingFile = true; this.render();
      try { for (const file of Array.from(files)) { const att = await attachmentDb.uploadFile(taskId, this.currentUserId, file); this.editAttachments.push(att); } } catch (err) { console.error(err); }
      this.uploadingFile = false; this.render();
    });
    for (const el of $$('[data-att-download]')) el.addEventListener('click', async () => {
      const att = this.editAttachments.find(a => a.id === el.dataset.attDownload);
      if (!att) return;
      try { const url = await attachmentDb.getDownloadUrl(att.storage_path); window.open(url, '_blank'); } catch (err) { console.error(err); }
    });
    for (const btn of $$('[data-att-del]')) btn.addEventListener('click', async () => {
      try { await attachmentDb.deleteAttachment(btn.dataset.attDel!, btn.dataset.attPath!); this.editAttachments = this.editAttachments.filter(a => a.id !== btn.dataset.attDel); this.render(); } catch (err) { console.error(err); }
    });

    // Comment bindings
    $('[data-comment-send]')?.addEventListener('click', async () => {
      const input = $('[data-comment-input]') as HTMLTextAreaElement | null;
      if (!input?.value.trim() || !this.editingTask) return;
      try { const c = await commentDb.createComment(this.editingTask.id, this.currentUserId, input.value.trim()); this.editComments.push(c); this.render(); } catch (err) { console.error(err); }
    });
    for (const btn of $$('[data-comment-del]')) btn.addEventListener('click', async () => {
      try { await commentDb.deleteComment(btn.dataset.commentDel!); this.editComments = this.editComments.filter(c => c.id !== btn.dataset.commentDel); this.render(); } catch (err) { console.error(err); }
    });

    this.bindAutocomplete();
  }

  // ── Autocomplete ────────────────────────────────────────────────────────

  private bindAutocomplete(): void {
    const textarea = this.el.querySelector<HTMLTextAreaElement>('[data-ac-target]');
    const acList = this.el.querySelector<HTMLElement>('[data-ac-list]');
    if (!textarea || !acList) return;

    const hideAc = () => { this.acVisible = false; this.acType = null; acList.style.display = 'none'; };

    const showAc = (items: string[], type: '@' | '/') => {
      if (!items.length) { hideAc(); return; }
      this.acVisible = true; this.acType = type; this.acIndex = 0; acList.style.display = '';
      const _taRect = textarea.getBoundingClientRect(); void _taRect;
      acList.style.left = '0';
      acList.style.top = (textarea.offsetTop + textarea.offsetHeight + 2) + 'px';
      acList.innerHTML = items.map((item, i) => {
        if (type === '@') {
          const m = this.members.find(x => (x.first_name || x.telegram_username || '') === item);
          const avatar = m?.photo_url
            ? `<img src="${esc(m.photo_url)}" style="width:18px;height:18px;border-radius:50%;object-fit:cover">`
            : `<span class="tm-avatar" style="width:18px;height:18px;font-size:9px">${esc(item.charAt(0).toUpperCase())}</span>`;
          return `<div class="tm-ac-item${i === 0 ? ' active' : ''}" data-ac-idx="${i}">${avatar} ${esc(item)}</div>`;
        }
        return `<div class="tm-ac-item${i === 0 ? ' active' : ''}" data-ac-idx="${i}">${IC.file} ${esc(item)}</div>`;
      }).join('');
      for (const el of acList.querySelectorAll<HTMLElement>('.tm-ac-item')) {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); insertAc(items[parseInt(el.dataset.acIdx!, 10)]); });
      }
    };

    const insertAc = (value: string) => {
      const pos = textarea.selectionStart;
      const text = textarea.value;
      const before = text.substring(0, this.acStartPos);
      const after = text.substring(pos);
      const prefix = this.acType === '@' ? '@' : '/';
      textarea.value = before + prefix + value + ' ' + after;
      const newPos = (before + prefix + value + ' ').length;
      textarea.selectionStart = textarea.selectionEnd = newPos;
      textarea.focus(); hideAc();
    };

    textarea.addEventListener('input', () => {
      const pos = textarea.selectionStart;
      const text = textarea.value;
      let triggerPos = -1;
      let triggerChar: '@' | '/' | null = null;
      for (let i = pos - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === '@' || ch === '/') { if (i === 0 || /\s/.test(text[i - 1])) { triggerPos = i; triggerChar = ch as '@' | '/'; } break; }
        if (/\s/.test(ch)) break;
      }
      if (triggerChar && triggerPos >= 0) {
        const query = text.substring(triggerPos + 1, pos).toLowerCase();
        this.acStartPos = triggerPos; this.acQuery = query;
        if (triggerChar === '@') {
          const names = this.members.map(m => m.first_name || m.telegram_username || '').filter(n => n && n.toLowerCase().includes(query)).slice(0, 8);
          showAc(names, '@');
        } else {
          const articles = this.products.map(p => getArticle(p)).filter(a => a && a.toLowerCase().includes(query)).slice(0, 8);
          showAc(articles, '/');
        }
      } else { hideAc(); }
    });

    textarea.addEventListener('keydown', (e) => {
      if (!this.acVisible) return;
      const items = acList.querySelectorAll<HTMLElement>('.tm-ac-item');
      if (!items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); items[this.acIndex]?.classList.remove('active'); this.acIndex = (this.acIndex + 1) % items.length; items[this.acIndex]?.classList.add('active'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[this.acIndex]?.classList.remove('active'); this.acIndex = (this.acIndex - 1 + items.length) % items.length; items[this.acIndex]?.classList.add('active'); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const allItems = this.acType === '@'
          ? this.members.map(m => m.first_name || m.telegram_username || '').filter(n => n && n.toLowerCase().includes(this.acQuery))
          : this.products.map(p => getArticle(p)).filter(a => a && a.toLowerCase().includes(this.acQuery));
        if (allItems[this.acIndex]) insertAc(allItems[this.acIndex]);
      } else if (e.key === 'Escape') { hideAc(); }
    });

    textarea.addEventListener('blur', () => { setTimeout(() => hideAc(), 150); });
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  private openNew(): void {
    this.editingTask = {
      id: uuid(), company_id: '', title: '', description: '',
      status: 'todo', priority: 'none',
      scheduled_date: null, due_date: null, due_time: null, end_time: null, all_day: true,
      tags: '', sort_order: this.tasks.length,
      completed_at: null, parent_id: null, assignee_id: null,
      created_at: '', updated_at: '',
    };
    this.resetModalFlags();
    this.render();
  }

  private async openEdit(id: string): Promise<void> {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return;
    this.editingTask = { ...t };
    this.editComments = [];
    this.editAttachments = [];
    this.resetModalFlags();
    // Auto-show subtasks if task has any
    const subs = this.subtasksOf(id);
    if (subs.length) this.modalShowSubs = true;
    if (t.scheduled_date) this.modalShowDate = true;
    if (t.due_date) this.modalShowDeadline = true;
    // Auto-show reminders if task has any
    const taskRems = this.reminders.filter(r => r.task_id === id);
    if (taskRems.length) this.modalShowReminders = true;
    this.render();
    try {
      const [comments, attachments] = await Promise.all([commentDb.getComments(id), attachmentDb.getAttachments(id)]);
      if (this.editingTask?.id === id) {
        this.editComments = comments;
        this.editAttachments = attachments;
        // Auto-show files/comments sections if they have data
        if (attachments.length) this.modalShowFiles = true;
        if (comments.length) this.modalShowComments = true;
        // Modal already visible — skip entrance animation to avoid jitter
        this.modalIsRefresh = true;
        this.render();
        this.modalIsRefresh = false;
      }
    } catch (e) { console.error('[TaskManager] load comments/attachments error', e); }
  }

  private async saveModal(): Promise<void> {
    if (!this.editingTask) return;
    const $ = (sel: string) => this.el.querySelector<HTMLElement>(sel);
    const val = (f: string) => ($(` [data-f="${f}"]`) as HTMLInputElement)?.value ?? '';

    const data: TaskUpdate = {
      title: val('title'), description: val('description'),
      priority: val('priority') as Priority, status: val('status') as Status,
      scheduled_date: val('scheduled_date') || null,
      due_date: val('due_date') || null, due_time: val('due_time') || null,
      end_time: val('end_time') || null,
      all_day: ($('[data-f="all_day"]') as HTMLInputElement)?.checked ?? true,
      tags: this.editingTask.tags, assignee_id: val('assignee_id') || null,
    };

    if (data.status === 'done' && this.editingTask.status !== 'done') data.completed_at = new Date().toISOString();
    else if (data.status !== 'done') data.completed_at = null;

    const isNew = !this.tasks.find(x => x.id === this.editingTask!.id);
    try {
      if (isNew) {
        const created = await taskDb.createTask({
          title: data.title || 'Без названия', description: data.description || '',
          status: data.status || 'todo', priority: data.priority || 'none',
          scheduled_date: data.scheduled_date ?? null,
          due_date: data.due_date ?? null, due_time: data.due_time ?? null,
          end_time: data.end_time ?? null,
          all_day: data.all_day ?? true, tags: data.tags || '',
          sort_order: this.tasks.length, parent_id: this.editingTask.parent_id || null,
          assignee_id: data.assignee_id ?? null,
        } as TaskCreate);
        this.tasks.push(created);
      } else {
        const updated = await taskDb.updateTask(this.editingTask.id, data);
        const idx = this.tasks.findIndex(x => x.id === this.editingTask!.id);
        if (idx >= 0) this.tasks[idx] = updated;
      }
    } catch (err) { console.error('[TaskManager] save error', err); }
    this.editingTask = null; this.resetModalFlags(); this.render();
  }

  /**
   * Save a brand-new task to the DB without closing the modal.
   * Called when the user clicks a module card (subtasks, reminders…) before
   * the task has been persisted — we need a real DB id for FK relations.
   * After save, this.editingTask is updated to point at the created record.
   */
  private async saveModalKeepOpen(): Promise<void> {
    if (!this.editingTask) return;
    const isUnsaved = !this.tasks.find(x => x.id === this.editingTask!.id);
    if (!isUnsaved) return; // already saved, nothing to do

    const $ = (sel: string) => this.el.querySelector<HTMLElement>(sel);
    const val = (f: string) => ($(` [data-f="${f}"]`) as HTMLInputElement)?.value ?? '';

    try {
      const created = await taskDb.createTask({
        title: val('title') || 'Без названия',
        description: val('description') || '',
        status: (val('status') as Status) || 'todo',
        priority: (val('priority') as Priority) || 'none',
        scheduled_date: val('scheduled_date') || null,
        due_date: val('due_date') || null,
        due_time: val('due_time') || null,
        end_time: val('end_time') || null,
        all_day: ($('[data-f="all_day"]') as HTMLInputElement)?.checked ?? true,
        tags: this.editingTask.tags || '',
        sort_order: this.tasks.length,
        parent_id: this.editingTask.parent_id || null,
        assignee_id: val('assignee_id') || null,
      } as TaskCreate);
      this.tasks.push(created);
      // Switch editingTask to the persisted record so modules work correctly
      this.editingTask = { ...created };
    } catch (err) {
      console.error('[TaskManager] saveModalKeepOpen error', err);
    }
  }

  private async quickAdd(title: string): Promise<void> {
    try {
      const created = await taskDb.createTask({ title, description: '', status: 'todo', priority: 'none', scheduled_date: null, due_date: null, due_time: null, end_time: null, all_day: true, tags: '', sort_order: this.tasks.length, parent_id: null, assignee_id: null });
      this.tasks.push(created); this.render();
    } catch (err) { console.error(err); }
  }

  private async quickAddWithStatus(title: string, status: Status): Promise<void> {
    try {
      const created = await taskDb.createTask({ title, description: '', status, priority: 'none', scheduled_date: null, due_date: null, due_time: null, end_time: null, all_day: true, tags: '', sort_order: this.tasks.length, parent_id: null, assignee_id: null });
      this.tasks.push(created); this.render();
    } catch (err) { console.error(err); }
  }

  private async toggleDone(id: string): Promise<void> {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return;
    const newStatus: Status = t.status === 'done' ? 'todo' : 'done';
    t.status = newStatus;
    t.completed_at = newStatus === 'done' ? new Date().toISOString() : null;
    this.render();
    try { await taskDb.updateTask(id, { status: newStatus, completed_at: t.completed_at }); } catch (err) { console.error(err); }
  }

  private async deleteTask(id: string): Promise<void> {
    const subs = this.tasks.filter(t => t.parent_id === id);
    const ids = new Set([id, ...subs.map(s => s.id)]);
    // Remove from local state immediately for instant UI feedback
    this.tasks = this.tasks.filter(x => !ids.has(x.id));
    this.reminders = this.reminders.filter(r => !ids.has(r.task_id || ''));
    this.editingTask = null; this.resetModalFlags(); this.render();
    try {
      // Delete each subtask individually first (same request pattern as deleteTask — known to work)
      for (const sub of subs) {
        await taskDb.deleteTask(sub.id);
      }
      // Then delete the parent
      await taskDb.deleteTask(id);
    } catch (err) { console.error('[TaskManager] deleteTask error', err); }
  }

  /** Get all unique tags used across all tasks */
  private getAllExistingTags(): string[] {
    const set = new Set<string>();
    for (const t of this.tasks) {
      if (t.tags) t.tags.split(',').forEach(tg => { const s = tg.trim(); if (s) set.add(s); });
    }
    return [...set];
  }

  /** Get tags of the currently editing task */
  private editingTaskTags(): string[] {
    if (!this.editingTask?.tags) return [];
    return this.editingTask.tags.split(',').map(t => t.trim()).filter(Boolean);
  }

  private addTagToEditing(tag: string): void {
    if (!this.editingTask) return;
    const tags = this.editingTaskTags();
    if (tags.includes(tag)) return;
    tags.push(tag);
    this.editingTask.tags = tags.join(',');
    this.render();
  }

  private removeTagFromEditing(tag: string): void {
    if (!this.editingTask) return;
    const tags = this.editingTaskTags().filter(t => t !== tag);
    this.editingTask.tags = tags.join(',');
    this.render();
  }

  /** Deterministic color for a tag based on its text */
  private getTagColor(tag: string): string {
    const TAG_COLORS = ['#6366f1','#ef4444','#f59e0b','#10b981','#3b82f6','#ec4899','#8b5cf6','#14b8a6','#f97316','#06b6d4'];
    let hash = 0;
    for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash) + tag.charCodeAt(i);
    return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
  }

  private resetModalFlags(): void {
    this.modalShowSubs = false;
    this.modalShowDate = false;
    this.modalShowReminders = false;
    this.modalShowFiles = false;
    this.modalShowComments = false;
    this.modalShowDeadline = false;
  }

  private async navigateToProduct(article: string): Promise<void> {
    this.productPopup = null;
    this.editingTask = null;
    this.resetModalFlags();
    this.render();
    // Navigate to products section and apply search filter
    const app = window.app;
    if (!app) return;
    // navigateTo is the correct method name in App.ts
    if (typeof app.navigateTo === 'function') {
      await app.navigateTo('home');
    }
    // Set search directly via onSearch (updates searchQ + applyFilters)
    if (typeof app.onSearch === 'function') {
      // Small delay to let the products view fully render
      setTimeout(() => app.onSearch(article), 120);
    } else {
      // Fallback: fill the search input element
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-search], input[placeholder*="Поиск"], input[placeholder*="артикул"], input[placeholder*="Артикул"]'
        );
        if (input) {
          input.value = article;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, 300);
    }
  }

  private calNav(dir: -1 | 1): void {
    if (this.calScope === 'month') this.calDate.setMonth(this.calDate.getMonth() + dir);
    else if (this.calScope === 'week') this.calDate.setDate(this.calDate.getDate() + dir * 7);
    else this.calDate.setDate(this.calDate.getDate() + dir);
    this.render();
  }
}
