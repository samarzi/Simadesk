import { apiService } from '../services/api';
import { idbCache } from '../services/idbCache';
import { esc as escHtml } from '../utils/format';
import { App } from '../App';

export class TableInteractionsModule {
  constructor(private app: App) {}

  // ─────────────────────────────────────────────────────────────────────────
  // FEATURE 1: DRAG-AND-DROP ROW REORDERING
  // ─────────────────────────────────────────────────────────────────────────

  onRowDragStart(idx: number) {
    this.app.dragFromIdx = idx;
  }

  onRowDragOver(el: HTMLElement, _idx: number) {
    // Remove indicator from all rows
    document.querySelectorAll('#vt-tbody tr').forEach(tr => (tr as HTMLElement).classList.remove('vt-drag-over'));
    el.classList.add('vt-drag-over');
  }

  onRowDragLeave(el: HTMLElement) {
    el.classList.remove('vt-drag-over');
  }

  onRowDrop(idx: number) {
    document.querySelectorAll('#vt-tbody tr').forEach(tr => (tr as HTMLElement).classList.remove('vt-drag-over'));
    if (this.app.dragFromIdx === null || this.app.dragFromIdx === idx) {
      this.app.dragFromIdx = null;
      return;
    }
    const from = this.app.dragFromIdx;
    const to = idx;
    this.app.dragFromIdx = null;

    // Reorder in filtered array
    const item = this.app.filtered.splice(from, 1)[0];
    this.app.filtered.splice(to, 0, item);

    // Sync back to allProducts by reordering within allProducts
    // Rebuild allProducts to match filtered order (filtered is a subset)
    const filteredIds = new Set(this.app.filtered.map(p => p.id));
    const notFiltered = this.app.allProducts.filter(p => !filteredIds.has(p.id));
    this.app.allProducts = [...this.app.filtered, ...notFiltered];

    if (this.app.activeBoxId) {
      this.app.cache.set(this.app.activeBoxId, this.app.allProducts);
      idbCache.set(this.app.activeBoxId, this.app.allProducts).catch(() => {});
    }

    this.app.applyFilters();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FEATURE 2: COLUMN REORDERING (in settings)
  // ─────────────────────────────────────────────────────────────────────────

  onColDragStart(e: DragEvent, idx: number) {
    this.app.dragColIdx = idx;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
    }
    (e.target as HTMLElement).classList.add('dragging');
  }

  onColDragOver(e: DragEvent, el: HTMLElement) {
    e.preventDefault();
    document.querySelectorAll('.col-pick-row').forEach(r => r.classList.remove('drag-over'));
    el.classList.add('drag-over');
  }

  onColDragLeave(el: HTMLElement) {
    el.classList.remove('drag-over');
  }

  onColDrop(e: DragEvent, toIdx: number) {
    e.preventDefault();
    document.querySelectorAll('.col-pick-row').forEach(r => r.classList.remove('drag-over', 'dragging'));

    const fromIdx = this.app.dragColIdx;
    this.app.dragColIdx = null;
    if (fromIdx === null || fromIdx === toIdx) return;

    // Реорганизуем this.columns (только те, что не в SKIP_COLS)
    const validCols = this.app.columns.filter(c => !App.SKIP_COLS.has(c));
    const item = validCols.splice(fromIdx, 1)[0];
    validCols.splice(toIdx, 0, item);

    // Сохраняем новый порядок для текущей группы
    if (this.app.activeBoxId) {
      this.app.columnOrder.set(this.app.activeBoxId, validCols);
      const co: Record<string, string[]> = {};
      for (const [bid, cols] of this.app.columnOrder) co[bid] = cols;
      localStorage.setItem('app_column_order', JSON.stringify(co));
    }

    // Перестраиваем полный список столбцов
    this.app.buildColumns();

    // Обновляем UI настроек (перерендерим модал)
    if (this.app.activeBoxId) {
      this.app.openBoxSettings(this.app.activeBoxId);
    }
  }

  onColDragEnd() {
    document.querySelectorAll('.col-pick-row').forEach(r => r.classList.remove('drag-over', 'dragging'));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FEATURE 2: MANUAL PRODUCT ADDITION
  // ─────────────────────────────────────────────────────────────────────────

  openAddProductModal() {
    if (!this.app.activeBoxId) {
      this.app.toast('Сначала выберите группу', 'error');
      return;
    }

    const defaultFields = ['Артикул*', 'Название товара', 'Цена, руб.*', 'Тип*', 'Цвет товара'];
    const fields = this.app.columns.length > 0 ? this.app.columns.slice(0, 20) : defaultFields;

    const body = `<table class="edit-table">${fields.map(k => `
      <tr>
        <td>${escHtml(k.replace('*', ''))}${k.endsWith('*') ? '<span style="color:var(--accent)">*</span>' : ''}</td>
        <td><input class="edit-inp" data-key="${escHtml(k)}" placeholder="${escHtml(k.replace('*', ''))}"></td>
      </tr>
    `).join('')}</table>`;

    this.app.openModalLg('Добавить товар', 'Заполните поля нового товара', body,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.saveNewProduct()">+ Добавить</button>`
    );
  }

  async saveNewProduct() {
    if (!this.app.activeBoxId) {
      this.app.toast('Нет активной группы', 'error');
      return;
    }

    const inputs = document.querySelectorAll<HTMLInputElement>('.edit-inp');
    const data: Record<string, string> = {};
    inputs.forEach(inp => {
      if (inp.dataset.key) data[inp.dataset.key] = inp.value;
    });

    const art = data['Артикул*'];
    if (!art || !art.trim()) {
      this.app.toast('Введите Артикул*', 'error');
      return;
    }

    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Добавляю...'; }

    try {
      const sheets = await apiService.getSheetsByBox(this.app.activeBoxId);
      if (!sheets || sheets.length === 0) {
        this.app.toast('Сначала импортируйте шаблон', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '+ Добавить'; }
        return;
      }
      const sheetId = sheets[0].id;

      const newProd = await apiService.createProduct({
        box_id: this.app.activeBoxId,
        sheet_id: sheetId,
        data
      });

      this.app.allProducts.unshift(newProd);
      this.app.cache.set(this.app.activeBoxId, this.app.allProducts);
      idbCache.set(this.app.activeBoxId, this.app.allProducts).catch(() => {});

      this.app.buildColumns();
      this.app.applyFilters();
      this.app.loadBoxCount(this.app.activeBoxId);

      this.app.toast('Товар добавлен', 'success');
      this.app.closeModal();
    } catch (e: any) {
      this.app.toast('Ошибка: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '+ Добавить'; }
    }
  }
}
