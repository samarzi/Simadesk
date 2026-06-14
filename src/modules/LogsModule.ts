/**
 * LogsModule — журнал всех изменений в системе.
 * Хранится в localStorage, пишется через changeLog.add().
 */
import { debug } from '@/utils/debug';
import { I } from '@/utils/icons';


export interface ChangeLogEntry {
  id: string;
  ts: string;              // ISO timestamp
  category: string;        // 'product' | 'price' | 'group' | 'import' | 'rule' | 'settings' | 'sync'
  action: string;          // короткое действие, напр. "Изменена цена"
  details: string;         // подробности
  user?: string;
  meta?: Record<string, any>;
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
  add(entry: Omit<ChangeLogEntry, 'id' | 'ts'>): void {
    const entries = load();
    entries.unshift({ ...entry, id: crypto.randomUUID(), ts: new Date().toISOString() });
    save(entries);
  },
  get(limit = 500): ChangeLogEntry[] { return load().slice(0, limit); },
  clear(): void { localStorage.removeItem(KEY); },
  exportCsv(): void {
    const entries = load();
    const rows = [['Дата','Время','Категория','Действие','Подробности']];
    for (const e of entries) {
      const d = new Date(e.ts);
      rows.push([
        d.toLocaleDateString('ru'),
        d.toLocaleTimeString('ru'),
        e.category,
        e.action,
        e.details,
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
  other: '#94a3b8',
};

export class LogsModule {
  private container: HTMLElement;
  private search = '';
  private filterCategory = '';
  private page = 0;
  private readonly PAGE_SIZE = 50;

  constructor(container: HTMLElement) { this.container = container; }

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.render();
  }

  hide(): void { this.container.style.display = 'none'; }

  setSearch(q: string): void { this.search = q; this.page = 0; this.render(); }
  setFilter(cat: string): void { this.filterCategory = cat; this.page = 0; this.render(); }
  nextPage(): void { this.page++; this.render(); }
  prevPage(): void { if (this.page > 0) { this.page--; this.render(); } }

  private esc(s: string): string {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  render(): void {
    const all = changeLog.get(MAX);
    const q = this.search.toLowerCase();
    const filtered = all.filter(e => {
      if (this.filterCategory && e.category !== this.filterCategory) return false;
      if (q && !`${e.action} ${e.details} ${e.category}`.toLowerCase().includes(q)) return false;
      return true;
    });

    const totalPages = Math.max(1, Math.ceil(filtered.length / this.PAGE_SIZE));
    const page = Math.min(this.page, totalPages - 1);
    const pageEntries = filtered.slice(page * this.PAGE_SIZE, (page + 1) * this.PAGE_SIZE);

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
          <span style="margin-left:auto;font-size:11px;color:var(--text-2)">${filtered.length} записей</span>
        </div>

        <!-- ТАБЛИЦА -->
        <div style="flex:1;overflow:auto;padding-bottom:90px">
          ${pageEntries.length === 0 ? `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:var(--text-2);padding:40px">
              <div style="font-size:40px">${I.clipboard('',40)}</div>
              <div style="font-size:16px;font-weight:600;color:var(--text)">${all.length === 0 ? 'Журнал пуст' : 'Ничего не найдено'}</div>
              <div style="font-size:13px;opacity:.65;text-align:center;max-width:320px">
                ${all.length === 0
                  ? 'Все изменения в системе (товары, цены, правила, импорт) будут фиксироваться здесь автоматически'
                  : 'Попробуйте изменить фильтры или поисковый запрос'}
              </div>
            </div>
          ` : `
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead>
                <tr style="background:var(--bg);position:sticky;top:0;z-index:1;border-bottom:2px solid var(--border)">
                  <th style="padding:9px 24px;text-align:left;font-size:10px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;width:140px">Дата / Время</th>
                  <th style="padding:9px 12px;text-align:left;font-size:10px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;width:120px">Категория</th>
                  <th style="padding:9px 12px;text-align:left;font-size:10px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Действие</th>
                  <th style="padding:9px 24px;text-align:left;font-size:10px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Подробности</th>
                </tr>
              </thead>
              <tbody>
                ${pageEntries.map(e => {
                  const d = new Date(e.ts);
                  const col = CATEGORY_COLORS[e.category] ?? '#64748b';
                  const catLabel = CATEGORY_LABELS[e.category] ?? e.category;
                  return `
                    <tr style="border-bottom:1px solid var(--border);background:var(--bg)" onmouseover="this.style.background='var(--bg-2)'" onmouseout="this.style.background='var(--bg)'">
                      <td style="padding:10px 24px;white-space:nowrap">
                        <div style="font-size:12px;font-weight:600;color:var(--text)">${d.toLocaleDateString('ru',{day:'2-digit',month:'short',year:'numeric'})}</div>
                        <div style="font-size:10px;color:var(--text-2)">${d.toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</div>
                      </td>
                      <td style="padding:10px 12px">
                        <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;
                          background:${col}18;color:${col}">${catLabel}</span>
                      </td>
                      <td style="padding:10px 12px;font-weight:600;color:var(--text)">${this.esc(e.action)}</td>
                      <td style="padding:10px 24px;color:var(--text-2);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.esc(e.details)}">${this.esc(e.details)}</td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          `}
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

  clearAll(): void { changeLog.clear(); this.render(); }
  exportCsv(): void { changeLog.exportCsv(); }
}
