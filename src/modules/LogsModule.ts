/**
 * LogsModule — журнал всех изменений в системе.
 * Хранится в localStorage, пишется через changeLog.add().
 */
import { debug } from '@/utils/debug';
import { I } from '@/utils/icons';
import { showToast } from '@/utils/toast';
import { authService } from '@/services/authService';
import { companyService } from '@/services/companyService';
import { dbFetch } from '@/services/dbClient';


export interface UndoSpec {
  kind: string;            // подсистема, умеющая откатывать (напр. 'docs')
  payload: any;            // снимок состояния «до» для восстановления
  label?: string;          // человеческое описание того, что откатится
}

export interface ChangeLogEntry {
  id: string;
  ts: string;              // ISO timestamp
  category: string;        // 'product' | 'price' | 'group' | 'import' | 'rule' | 'settings' | 'sync' | 'ai' | 'undo'
  action: string;          // короткое действие, напр. "Изменена цена"
  details: string;         // подробности
  user?: string;           // имя пользователя (auto-fill из authService)
  userId?: string;         // UUID пользователя (для groupKey и фильтрации)
  relatedId?: string;      // id исходной записи (для undo-события)
  meta?: Record<string, any>;
  // ── AI-действия / дерево запросов / откат ──
  requestText?: string;    // исходный запрос пользователя (1 запрос = 1 действие)
  groupKey?: string;       // одинаковые запросы копятся в одно дерево
  undo?: UndoSpec;         // если задано — действие можно откатить
  undone?: boolean;        // уже откачено
}

// ── Реестр обработчиков отката ──────────────────────────────────────────────────
// Подсистемы (редактор и т.п.) регистрируют, как откатывать свои действия.
type UndoHandler = (payload: any) => void | Promise<void>;
const undoHandlers: Record<string, UndoHandler> = {};
export function registerUndoHandler(kind: string, fn: UndoHandler): void {
  undoHandlers[kind] = fn;
}

/** Нормализация текста запроса → ключ дерева. Включает userId, чтобы запросы разных пользователей не смешивались. */
function makeGroupKey(requestText: string | undefined, action: string, userId?: string): string {
  const base = (requestText ?? action ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const text = base || action || 'other';
  return userId ? `${userId}:${text}` : text;
}

const KEY = 'change_log_v1';
const MAX = 2000;
const RETENTION_DAYS = 50;

function load(): ChangeLogEntry[] {
  try {
    const all: ChangeLogEntry[] = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    // Автоматически удаляем записи старше 50 дней
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    return all.filter(e => new Date(e.ts).getTime() >= cutoff);
  } catch { return []; }
}
function save(entries: ChangeLogEntry[]): void {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const fresh = entries.filter(e => new Date(e.ts).getTime() >= cutoff).slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(fresh)); } catch (e) { debug.warn('[LogsModule] swallowed error', e); }
}

export const changeLog = {
  add(entry: Omit<ChangeLogEntry, 'id' | 'ts'>): string {
    const entries = load();
    const id = crypto.randomUUID();
    // Авто-заполнение user/userId из текущей сессии, если не переданы явно
    const authUser = authService.getUser();
    const userName = entry.user ?? (authUser
      ? (authUser.display_name || authUser.username || authUser.first_name || undefined)
      : undefined);
    const userId = entry.userId ?? authUser?.id;
    const full: ChangeLogEntry = { ...entry, id, ts: new Date().toISOString(), user: userName, userId };
    entries.unshift(full);
    save(entries);
    this._pushToServer(full);
    return id;
  },

  /** Записать действие (напр. от ассистента) с группировкой и возможностью отката. */
  logAction(a: {
    category?: string;
    action: string;
    details: string;
    requestText?: string;
    undo?: UndoSpec;
  }): string {
    const authUser = authService.getUser();
    const userId = authUser?.id;
    return this.add({
      category: a.category ?? 'ai',
      action: a.action,
      details: a.details,
      requestText: a.requestText,
      groupKey: makeGroupKey(a.requestText, a.action, userId),
      undo: a.undo,
      undone: false,
    });
  },

  get(limit = 500): ChangeLogEntry[] { return load().slice(0, limit); },
  getById(id: string): ChangeLogEntry | undefined { return load().find(e => e.id === id); },

  /** Пометить запись как откаченную. */
  markUndone(id: string): void {
    const entries = load();
    const e = entries.find(x => x.id === id);
    if (e) { e.undone = true; save(entries); }
  },

  /** Откатить одно действие. Возвращает текст результата. */
  async undo(id: string): Promise<string> {
    const e = this.getById(id);
    if (!e) return 'Запись не найдена';
    if (!e.undo) return 'Это действие нельзя отменить';
    if (e.undone) return 'Уже отменено';
    const handler = undoHandlers[e.undo.kind];
    if (!handler) return `Нет обработчика отката «${e.undo.kind}»`;
    await handler(e.undo.payload);
    this.markUndone(id);
    // Аудиторная запись об отмене (кто, когда, что откатил)
    this.add({
      category: 'undo',
      action: `Отменено: ${e.action}`,
      details: e.undo.label ?? e.details,
      relatedId: id,
    });
    return `Отменено: ${e.action}`;
  },

  /** Откатить всё дерево (все откатываемые действия группы), новейшие → старейшие. */
  async undoGroup(groupKey: string): Promise<string> {
    const entries = load()
      .filter(e => e.groupKey === groupKey && e.undo && !e.undone)
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()); // новые первыми
    let n = 0;
    const undoneIds: string[] = [];
    for (const e of entries) {
      const handler = undoHandlers[e.undo!.kind];
      if (handler) { await handler(e.undo!.payload); this.markUndone(e.id); n++; undoneIds.push(e.id); }
    }
    if (n > 0) {
      // Одна аудиторная запись на всё дерево
      this.add({
        category: 'undo',
        action: `Отменено дерево (${n} действий)`,
        details: entries[0]?.requestText ?? entries[0]?.action ?? groupKey,
        relatedId: undoneIds[0],
      });
    }
    return n ? `Отменено действий в дереве: ${n}` : 'Нечего отменять';
  },

  /** Откатить самое последнее откатываемое действие. */
  async undoLast(): Promise<string> {
    const entries = load().filter(e => e.undo && !e.undone);
    if (!entries.length) return 'Нет действий для отмены';
    return this.undo(entries[0].id);
  },

  /** Асинхронно (fire-and-forget) отправить одну запись на сервер. */
  _pushToServer(entry: ChangeLogEntry): void {
    const companyId = companyService.getActive()?.id;
    if (!companyId || !authService.isLoggedIn()) return;
    const row = {
      id:           entry.id,
      company_id:   companyId,
      user_id:      entry.userId ?? null,
      user_name:    entry.user ?? null,
      category:     entry.category,
      action:       entry.action,
      details:      entry.details,
      related_id:   entry.relatedId ?? null,
      request_text: entry.requestText ?? null,
      group_key:    entry.groupKey ?? null,
      undone:       entry.undone ?? false,
      ts:           entry.ts,
    };
    dbFetch<void>('action_log', {
      method: 'POST',
      body: JSON.stringify(row),
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal', 'Content-Type': 'application/json' },
    }).catch(e => debug.warn('[LogsModule] action_log push failed', e));
  },

  /** Загрузить последние записи с сервера и смержить в localStorage-кеш. */
  async syncFromServer(): Promise<void> {
    const companyId = companyService.getActive()?.id;
    if (!companyId || !authService.isLoggedIn()) return;
    try {
      const rows = await dbFetch<Array<{
        id: string; user_id: string | null; user_name: string | null;
        category: string; action: string; details: string;
        related_id: string | null; request_text: string | null;
        group_key: string | null; undone: boolean; ts: string;
      }>>(`action_log?company_id=eq.${companyId}&order=ts.desc&limit=2000`);
      if (!Array.isArray(rows) || rows.length === 0) return;
      // Смержить: серверные данные приоритетнее, локальные уникальные — сохраняем
      const local = load();
      const localById = new Map(local.map(e => [e.id, e]));
      for (const r of rows) {
        localById.set(r.id, {
          id: r.id,
          ts: r.ts,
          category: r.category,
          action: r.action,
          details: r.details,
          user: r.user_name ?? undefined,
          userId: r.user_id ?? undefined,
          relatedId: r.related_id ?? undefined,
          requestText: r.request_text ?? undefined,
          groupKey: r.group_key ?? undefined,
          undone: r.undone,
        });
      }
      const merged = [...localById.values()]
        .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
      save(merged);
    } catch (e) {
      debug.warn('[LogsModule] syncFromServer failed', e);
    }
  },

  clear(): void { localStorage.removeItem(KEY); },
  exportCsv(): void {
    const entries = load();
    const rows = [['Дата','Время','Пользователь','Категория','Действие','Подробности','Статус']];
    for (const e of entries) {
      const d = new Date(e.ts);
      const status = e.undone ? 'Отменено' : (e.category === 'undo' ? 'Отмена' : 'Выполнено');
      rows.push([
        d.toLocaleDateString('ru'),
        d.toLocaleTimeString('ru'),
        e.user ?? '',
        e.category,
        e.action,
        e.details,
        status,
      ]);
    }
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `logs_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  },
};

const CATEGORY_LABELS: Record<string, string> = {
  product: `${I.package('',14)} Товар`,
  price: `${I.dollarSign('',14)} Цена`,
  group: `${I.folder('',14)} Группа`,
  import: `${I.download('',14)} Импорт`,
  rule: `${I.settings('',14)} Правило`,
  settings: `${I.settings('',14)} Настройки`,
  sync: `${I.refresh('',14)} Синхронизация`,
  column: `${I.chart('',14)} Колонка`,
  undo: `↩ Отмена`,
  other: `${I.type('',14)} Прочее`,
};

const CATEGORY_COLORS: Record<string, string> = {
  product: '#005bff',
  price: '#16a34a',
  group: '#7c3aed',
  import: '#0891b2',
  rule: '#059669',
  settings: '#64748b',
  sync: '#f59e0b',
  column: '#8b5cf6',
  undo: '#dc2626',
  other: '#94a3b8',
};

export class LogsModule {
  private container: HTMLElement;
  private search = '';
  private filterCategory = '';
  private filterUser = '';
  private page = 0;
  private readonly PAGE_SIZE = 50;
  private expanded = new Set<string>();  // раскрытые деревья (groupKey)

  constructor(container: HTMLElement) { this.container = container; }

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.render();
    // Фоновая синхронизация с сервером — подтянуть записи других участников команды
    changeLog.syncFromServer().then(() => this.render()).catch(() => {});
  }

  hide(): void { this.container.style.display = 'none'; }

  setSearch(q: string): void { this.search = q; this.page = 0; this.render(); }
  setFilter(cat: string): void { this.filterCategory = cat; this.page = 0; this.render(); }
  setUserFilter(u: string): void { this.filterUser = u; this.page = 0; this.render(); }
  nextPage(): void { this.page++; this.render(); }
  prevPage(): void { if (this.page > 0) { this.page--; this.render(); } }

  private esc(s: string): string {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  render(): void {
    const all = changeLog.get(MAX);
    const q = this.search.toLowerCase();
    // Уникальные пользователи из всего журнала (для dropdown-фильтра)
    const allUsers = [...new Set(all.map(e => e.user).filter(Boolean) as string[])].sort();
    const filtered = all.filter(e => {
      if (this.filterCategory && e.category !== this.filterCategory) return false;
      if (this.filterUser && e.user !== this.filterUser) return false;
      if (q && !`${e.action} ${e.details} ${e.category} ${e.user ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });

    // ── Группировка в деревья по groupKey (одинаковые запросы — одно дерево) ──
    const groupMap = new Map<string, ChangeLogEntry[]>();
    for (const e of filtered) {
      const key = e.groupKey || e.id; // без groupKey — своё «дерево» из одной записи
      const arr = groupMap.get(key) ?? [];
      arr.push(e);
      groupMap.set(key, arr);
    }
    // Дерево: { key, entries (новые→старые), latestTs }
    const groups = [...groupMap.entries()].map(([key, entries]) => ({
      key,
      entries: entries.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()),
      latestTs: Math.max(...entries.map(e => new Date(e.ts).getTime())),
    })).sort((a, b) => b.latestTs - a.latestTs);

    const totalPages = Math.max(1, Math.ceil(groups.length / this.PAGE_SIZE));
    const page = Math.min(this.page, totalPages - 1);
    const pageGroups = groups.slice(page * this.PAGE_SIZE, (page + 1) * this.PAGE_SIZE);

    const categories = [...new Set(all.map(e => e.category))];

    this.container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;background:var(--bg-2)">

        <!-- TOP BAR -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 24px;
          background:var(--bg);border-bottom:1px solid var(--border);gap:12px;flex-shrink:0">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:32px;height:32px;border-radius:8px;background:#64748b;display:flex;align-items:center;justify-content:center">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 6h8M4 9h8M4 12h4"/><rect x="2" y="2" width="12" height="14" rx="2"/>
              </svg>
            </div>
            <div>
              <span style="font-size:18px;font-weight:700;color:var(--text-1)">Журнал изменений</span>
              <div style="font-size:11px;color:var(--text-2);margin-top:1px">Все действия в системе · ${all.length} записей</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button onclick="window.logsModule.exportCsv()"
              style="padding:7px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--text);cursor:pointer;font-size:12px">
              ${I.download('',14)} Экспорт CSV
            </button>
            ${all.length > 0 ? `
              <button onclick="if(confirm('Очистить весь журнал?')){window.logsModule.clearAll()}"
                style="padding:7px 14px;border-radius:8px;border:1px solid #fecaca;background:#fff5f5;color:#dc2626;cursor:pointer;font-size:12px">
                ${I.trash('',14)} Очистить
              </button>` : ''}
          </div>
        </div>

        <!-- ФИЛЬТРЫ -->
        <div style="display:flex;gap:8px;padding:10px 24px;background:var(--bg);border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center;flex-shrink:0">
          <input type="search" placeholder="Поиск по тексту…" value="${this.esc(this.search)}"
            oninput="window.logsModule.setSearch(this.value)"
            style="flex:1;min-width:180px;padding:7px 12px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:8px;font-size:12px">
          <button onclick="window.logsModule.setFilter('')"
            style="padding:5px 12px;border:1.5px solid ${!this.filterCategory?'#64748b':'var(--border)'};
              background:${!this.filterCategory?'#64748b18':'transparent'};color:${!this.filterCategory?'#64748b':'var(--text-2)'};
              border-radius:20px;cursor:pointer;font-size:11px;font-weight:${!this.filterCategory?'700':'400'}">
            Все категории
          </button>
          ${categories.map(cat => {
            const on = this.filterCategory === cat;
            const col = CATEGORY_COLORS[cat] ?? '#64748b';
            return `<button onclick="window.logsModule.setFilter('${cat}')"
              style="padding:5px 12px;border:1.5px solid ${on?col:'var(--border)'};
                background:${on?col+'18':'transparent'};color:${on?col:'var(--text-2)'};
                border-radius:20px;cursor:pointer;font-size:11px;font-weight:${on?'700':'400'}">
              ${CATEGORY_LABELS[cat] ?? cat}
            </button>`;
          }).join('')}
          ${allUsers.length > 1 ? `
            <select onchange="window.logsModule.setUserFilter(this.value)"
              style="padding:5px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);
                border-radius:8px;font-size:11px;cursor:pointer">
              <option value="" ${!this.filterUser?'selected':''}>Все участники</option>
              ${allUsers.map(u => `<option value="${this.esc(u)}" ${this.filterUser===u?'selected':''}>${this.esc(u)}</option>`).join('')}
            </select>
          ` : ''}
          <span style="margin-left:auto;font-size:11px;color:var(--text-2)">${filtered.length} записей</span>
        </div>

        <!-- ДЕРЕВЬЯ ДЕЙСТВИЙ -->
        <div style="flex:1;overflow:auto;padding:8px 16px 90px">
          ${pageGroups.length === 0 ? `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:var(--text-2);padding:40px">
              <div style="font-size:40px">${I.clipboard('',40)}</div>
              <div style="font-size:16px;font-weight:600;color:var(--text)">${all.length === 0 ? 'Журнал пуст' : 'Ничего не найдено'}</div>
              <div style="font-size:13px;opacity:.65;text-align:center;max-width:360px">
                ${all.length === 0
                  ? 'Здесь появятся действия ассистента и изменения в системе. Одинаковые запросы собираются в одно дерево, любое действие можно отменить.'
                  : 'Попробуйте изменить фильтры или поисковый запрос'}
              </div>
            </div>
          ` : pageGroups.map(g => this.groupHtml(g.key, g.entries)).join('')}
        </div>

        <!-- ПАГИНАЦИЯ -->
        ${totalPages > 1 ? `
          <div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 24px;border-top:1px solid var(--border);background:var(--bg);flex-shrink:0">
            <button onclick="window.logsModule.prevPage()" ${page === 0 ? 'disabled' : ''}
              style="padding:6px 14px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:8px;cursor:pointer;font-size:12px;opacity:${page===0?.4:1}">
              ← Назад
            </button>
            <span style="font-size:12px;color:var(--text-2)">Страница ${page+1} из ${totalPages}</span>
            <button onclick="window.logsModule.nextPage()" ${page >= totalPages-1 ? 'disabled' : ''}
              style="padding:6px 14px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:8px;cursor:pointer;font-size:12px;opacity:${page>=totalPages-1?.4:1}">
              Вперёд →
            </button>
          </div>
        ` : ''}

      </div>
    `;
  }

  // ── Рендер одного действия (строки) ────────────────────────────────────────
  private entryRowHtml(e: ChangeLogEntry, isChild: boolean): string {
    const d = new Date(e.ts);
    const col = CATEGORY_COLORS[e.category] ?? '#64748b';
    const catLabel = CATEGORY_LABELS[e.category] ?? e.category;
    const time = d.toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const userBadge = e.user
      ? `<span style="padding:2px 7px;border-radius:8px;font-size:10px;font-weight:600;background:var(--bg2);color:var(--text-2);white-space:nowrap;border:1px solid var(--border)" title="Пользователь">${this.esc(e.user)}</span>`
      : '';
    const undoBtn = e.undo && !e.undone
      ? `<button onclick="window.logsModule.undoEntry('${e.id}')"
           style="padding:4px 10px;border-radius:7px;border:1px solid #16a34a55;background:#16a34a14;color:#16a34a;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap">
           ↩ Отменить</button>`
      : e.undone
        ? `<span style="padding:3px 9px;border-radius:7px;background:#94a3b820;color:#94a3b8;font-size:10px;font-weight:600;white-space:nowrap">✓ откачено</span>`
        : '';
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:9px 12px;${isChild ? 'padding-left:34px;' : ''}
        border-bottom:1px solid var(--border);${e.undone ? 'opacity:.55;' : ''}">
        <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:${col}18;color:${col};white-space:nowrap">${catLabel}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--text);${e.undone ? 'text-decoration:line-through;' : ''}">${this.esc(e.action)}</div>
          <div style="font-size:11px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.esc(e.details)}">${this.esc(e.details)}</div>
        </div>
        ${userBadge}
        <div style="font-size:10px;color:var(--text-2);white-space:nowrap">${time}</div>
        ${undoBtn}
      </div>`;
  }

  // ── Рендер дерева (группы одинаковых запросов) ──────────────────────────────
  private groupHtml(key: string, entries: ChangeLogEntry[]): string {
    // Одиночное действие — просто карточка-строка.
    if (entries.length === 1) {
      return `<div style="border:1px solid var(--border);border-radius:10px;background:var(--bg);margin-bottom:8px;overflow:hidden">
        ${this.entryRowHtml(entries[0], false)}
      </div>`;
    }

    const head = entries[0];
    const title = head.requestText || head.action;
    const undoableLeft = entries.filter(e => e.undo && !e.undone).length;
    const isOpen = this.expanded.has(key);
    const encKey = encodeURIComponent(key);

    const treeUndo = undoableLeft > 0
      ? `<button onclick="event.stopPropagation();window.logsModule.undoTree('${encKey}')"
           style="padding:5px 11px;border-radius:7px;border:1px solid #dc262655;background:#dc262614;color:#dc2626;cursor:pointer;font-size:11px;font-weight:700;white-space:nowrap">
           ↩ Отменить дерево (${undoableLeft})</button>`
      : `<span style="padding:3px 9px;border-radius:7px;background:#94a3b820;color:#94a3b8;font-size:10px;font-weight:600">всё откачено</span>`;

    return `<div style="border:1px solid var(--border);border-radius:10px;background:var(--bg);margin-bottom:8px;overflow:hidden">
      <div onclick="window.logsModule.toggleGroup('${encKey}')"
        style="display:flex;align-items:center;gap:10px;padding:11px 12px;cursor:pointer;background:var(--bg-2)">
        <span style="font-size:12px;color:var(--text-2);transition:transform .15s;transform:rotate(${isOpen ? 90 : 0}deg)">▶</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(title)}</div>
          <div style="font-size:11px;color:var(--text-2)">Дерево из ${entries.length} одинаковых запросов</div>
        </div>
        <span style="padding:2px 9px;border-radius:12px;background:#6366f120;color:#6366f1;font-size:11px;font-weight:700">${entries.length}</span>
        ${treeUndo}
      </div>
      ${isOpen ? `<div>${entries.map(e => this.entryRowHtml(e, true)).join('')}</div>` : ''}
    </div>`;
  }

  toggleGroup(encKey: string): void {
    const key = decodeURIComponent(encKey);
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    this.render();
  }

  async undoEntry(id: string): Promise<void> {
    const msg = await changeLog.undo(id);
    this.render();
    showToast(msg, 'success');
  }

  async undoTree(encKey: string): Promise<void> {
    const key = decodeURIComponent(encKey);
    const msg = await changeLog.undoGroup(key);
    this.render();
    showToast(msg, 'success');
  }

  clearAll(): void { changeLog.clear(); this.render(); }
  exportCsv(): void { changeLog.exportCsv(); }
}
