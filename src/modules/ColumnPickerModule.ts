/**
 * ColumnPickerModule — управление видимостью и порядком столбцов.
 *
 * Извлечён из App.ts для уменьшения размера god-объекта.
 * Хранит модальный UI и делегирует изменения состояния обратно в App
 * через публичные свойства: visibleCols, columnOrder, columns.
 */

import { I } from '@/utils/icons';
import { customColumnsDb } from '@/services/customColumnsDb';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { App } from '../App';

export class ColumnPickerModule {
  constructor(private app: App) {}

  /** Открыть модал управления столбцами. */
  openColPickerModal(): void {
    const app = this.app;
    const customCols = customColumnsDb.getColumns(app.activeBoxId);
    const dataCols = app.columns.filter(c => !App.SKIP_COLS.has(c));

    const customRows = customCols.map(c => {
      const isSystem = c.system;
      const typeLabel = c.data_type === 'number' ? I.hash('', 12) : I.type('', 12);
      return `
        <div class="sh-col-row" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border)"
          draggable="${!isSystem}"
          data-col-id="${app.esc(c.id)}"
          ondragstart="window.app.onColDragStart(event,${customCols.indexOf(c)})"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="event.preventDefault();this.classList.remove('drag-over');window.app.onColDrop(event,${customCols.indexOf(c)})">
          <div style="cursor:${isSystem ? 'default' : 'grab'};font-size:14px;flex-shrink:0;color:var(--muted)" title="${isSystem ? 'Системная колонка' : 'Перетащить для изменения порядка'}">
            ${isSystem ? I.lock('', 14) : '⠿'}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px">${app.esc(c.label)}</div>
            <div style="font-size:10px;color:var(--muted)">${typeLabel} ${c.data_type === 'number' ? 'Число' : 'Текст'}${isSystem ? ' · Системная' : ' · Пользовательская'}</div>
          </div>
          <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);cursor:pointer;flex-shrink:0">
            <input type="checkbox" ${c.show_in_table ? 'checked' : ''} style="accent-color:#005bff"
              onchange="window.app.toggleCustomColumnVisibility('${app.esc(c.id)}',this.checked)">
            В таблице
          </label>
          ${!isSystem ? `
            <button onclick="window.app.deleteCustomColumn('${app.esc(c.id)}','${app.esc(c.label).replace(/'/g, '&#39;')}')"
              style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px;flex-shrink:0;padding:0 2px" title="Удалить">✕</button>
          ` : '<div style="width:20px"></div>'}
        </div>`;
    }).join('');

    const addColForm = `
      <div style="padding:12px;background:var(--bg2);border-top:1px solid var(--border)">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Добавить кастомный ряд</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <input id="cm-label" class="form-input" placeholder="Название поля" style="flex:1;min-width:140px">
          <select id="cm-type" class="form-select" style="width:100px">
            <option value="text">Текст</option>
            <option value="number">Число</option>
          </select>
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;white-space:nowrap">
            <input type="checkbox" id="cm-show" checked style="accent-color:#005bff"> В таблице
          </label>
          <button class="btn btn-primary" style="font-size:12px;padding:5px 12px"
            onclick="window.app.addCustomColumnFromModal()">+ Создать</button>
        </div>
      </div>`;

    const dataRows = dataCols.map((c, idx) => {
      const vis = app.visibleCols === null || app.visibleCols.has(c);
      return `
        <div class="col-pick-row" style="display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--border)"
          draggable="true"
          ondragstart="window.app.onColDragStart(event,${idx})"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="event.preventDefault();this.classList.remove('drag-over');window.app.onColDrop(event,${idx})">
          <div style="cursor:grab;font-size:12px;color:var(--muted);flex-shrink:0">⠿</div>
          <label style="flex:1;display:flex;align-items:center;gap:8px;cursor:pointer;min-width:0">
            <input type="checkbox" class="col-pick-chk" data-col="${app.esc(c)}" ${vis ? 'checked' : ''} style="accent-color:#005bff;flex-shrink:0">
            <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${app.esc(c.replace('*', ''))}</span>
          </label>
        </div>`;
    }).join('');

    const body = `
      <div style="display:flex;flex-direction:column;gap:0">
        <div style="margin-bottom:16px">
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;padding:10px 12px 6px;background:var(--bg2);border-bottom:1px solid var(--border)">
            Кастомные поля (Себестоимость + пользовательские)
          </div>
          <div id="custom-cols-list">
            ${customRows || '<div style="padding:12px;font-size:12px;color:var(--muted)">Нет кастомных полей</div>'}
          </div>
          ${addColForm}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;padding:10px 12px 6px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
            <span>Столбцы из данных товаров (МП / xlsx)</span>
            <div style="display:flex;gap:6px">
              <button class="btn" style="font-size:10px;padding:2px 8px" onclick="window.app.colPickAll(true)">Все</button>
              <button class="btn" style="font-size:10px;padding:2px 8px" onclick="window.app.colPickAll(false)">Снять</button>
            </div>
          </div>
          <div id="data-cols-list" style="max-height:280px;overflow-y:auto">
            ${dataRows || '<div style="padding:12px;font-size:12px;color:var(--muted)">Нет данных — сначала синхронизируйте товары</div>'}
          </div>
        </div>
      </div>`;

    app.openModalLg('Управление столбцами', '', body,
      `<button class="btn" onclick="window.app.closeModal()">Закрыть</button>
       <button class="btn btn-primary" onclick="window.app.applyColPicker()">Применить</button>`
    );
  }

  addCustomColumnFromModal(): void {
    const app = this.app;
    const labelEl = document.getElementById('cm-label') as HTMLInputElement;
    const typeEl  = document.getElementById('cm-type')  as HTMLSelectElement;
    const showEl  = document.getElementById('cm-show')  as HTMLInputElement;
    const label   = labelEl?.value?.trim();
    if (!label) { labelEl?.focus(); app.toast('Введите название', 'error'); return; }
    customColumnsDb.addColumn({
      label,
      data_type: (typeEl?.value || 'text') as 'text' | 'number',
      show_in_table: showEl?.checked ?? true,
      box_id: app.activeBoxId || null,
    });
    app.buildColumnsAndRefresh();
    this.openColPickerModal();
    app.toast(`Поле «${label}» создано`, 'success', 2000);
  }

  deleteCustomColumn(id: string, label: string): void {
    const app = this.app;
    app.openModal(
      'Удалить колонку?',
      '',
      `<p style="margin:0;padding:16px 0 8px">Колонка <b>${app.esc(label)}</b> будет удалена без возможности восстановления.</p>`,
      `<button class="btn btn-danger" onclick="window.app._confirmDeleteCustomColumn('${app.esc(id)}')">Удалить</button>
       <button class="btn btn-outline" onclick="window.app.closeModal()">Отмена</button>`,
    );
  }

  confirmDeleteCustomColumn(id: string): void {
    const app = this.app;
    app.closeModal();
    customColumnsDb.deleteColumn(id);
    app.buildColumnsAndRefresh();
    this.openColPickerModal();
  }

  toggleCustomColumnVisibility(id: string, show: boolean): void {
    customColumnsDb.updateColumn(id, { show_in_table: show });
    this.app.buildColumnsAndRefresh();
  }

  colPickAll(checked: boolean): void {
    document.querySelectorAll<HTMLInputElement>('.col-pick-chk').forEach(chk => { chk.checked = checked; });
  }

  applyColPicker(): void {
    const app = this.app;
    const selected: string[] = [];
    document.querySelectorAll<HTMLInputElement>('.col-pick-chk:checked').forEach(chk => {
      const col = chk.dataset.col;
      if (col) selected.push(col);
    });
    const allCols = app.columns.filter(c => !App.SKIP_COLS.has(c));
    app.visibleCols = selected.length === allCols.length ? null : new Set(selected);
    localStorage.setItem('app_visible_cols', JSON.stringify(selected.length === allCols.length ? null : selected));
    app.closeModal();
    app.renderProducts();
  }

  toggleCustomCols(): void {
    this.app.toggleCustomCols();
    this.app.applyFilters();
  }
}
