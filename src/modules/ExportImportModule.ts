import { debug } from '@/utils/debug';
import * as XLSX from 'xlsx';
import { boxes } from '../stores/appStore';
import { apiService } from '../services/api';
import { idbCache } from '../services/idbCache';
import { esc as escHtml } from '../utils/format';
import type { App } from '../App';

/** Экспорт/импорт товаров через xlsx (включая оригинальные шаблоны МП). */
export class ExportImportModule {
  constructor(private app: App) {}

  // ── Import state ──────────────────────────────────────────────────────────
  private parsedImport: { filename: string; headers: string[]; rows: any[][]; format: string; templateHeaders?: any[][]; template_file_b64?: string } | null = null;
  private importCtx: {
    boxId: string;
    selColIdxs: Set<number>;
    selRowIdxs: Set<number>;
    filename: string;
    headers: string[];
    rows: any[][];
    templateHeaders?: any[][];
    template_file_b64?: string;
    artIdx: number;
    existingArts: Set<string>;
    btn: HTMLButtonElement | null;
  } | null = null;

  private async ensureExcelJS(): Promise<any> {
    if ((window as any).ExcelJS) return (window as any).ExcelJS;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
      s.onload = () => resolve((window as any).ExcelJS);
      s.onerror = () => reject(new Error('Не удалось загрузить библиотеку ExcelJS из CDN'));
      document.head.appendChild(s);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXPORT
  // ─────────────────────────────────────────────────────────────────────────

  openExportModal(onlySelected = false) {
    if (!this.app.activeBoxId) { this.app.toast('Сначала выберите группу', 'error'); return; }
    const box = boxes.get().find(b => b.id === this.app.activeBoxId);
    let prods = this.app.filtered.length ? this.app.filtered : this.app.allProducts;
    if (onlySelected && this.app.selectedProducts.size > 0) {
      prods = prods.filter(p => this.app.selectedProducts.has(p.id));
    }
    if (!prods.length) { this.app.toast('Нет товаров для экспорта', 'error'); return; }
    if (!prods.length) { this.app.toast('Нет товаров для экспорта', 'error'); return; }
    const allCols = this.app.columns;

    this.app.openModalLg(`Экспорт — ${escHtml(box?.name || '')}`, `${prods.length} товаров доступно`,
      `<div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите столбцы для экспорта</div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportCols(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportCols(false)">Снять</button>
        </div>
      </div>
      <div id="export-col-sel" style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:16px;max-height:160px;overflow-y:auto;padding-right:4px">
        ${allCols.map(c => `
          <div class="chk on" data-ecol="${escHtml(c)}" onclick="this.classList.toggle('on');window.app.updateExportCount()">
            <div class="chk-box"><div class="chk-tick"></div></div>
            <span class="chk-label" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(c)}">${escHtml(c.replace('*', ''))}</span>
          </div>
        `).join('')}
      </div>
      <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите позиции для экспорта</div>
        <div style="display:flex;gap:6px">
          ${onlySelected ? '' : `<button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportRows(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportRows(false)">Снять</button>`}
        </div>
      </div>
      <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="width:36px;padding:8px 10px;background:var(--bg4);border-bottom:1px solid var(--border)"></th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Артикул</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border)">Название</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Цена</th>
          </tr></thead>
          <tbody id="export-row-body">
            ${prods.map(p => {
              const d = p.data || {};
              return `<tr class="exp-row on" data-prod-id="${p.id}" onclick="this.classList.toggle('on');window.app.updateExportCount()" style="cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s">
                <td style="padding:8px 10px;text-align:center"><div class="chk-box" style="margin:0 auto"><div class="chk-tick"></div></div></td>
                <td style="padding:8px 10px;font-size:11px;color:var(--text3);white-space:nowrap">${escHtml(d['Артикул*'] || '')}</td>
                <td style="padding:8px 10px;font-size:12px;color:var(--text);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(d['Название товара'] || '')}</td>
                <td style="padding:8px 10px;font-size:12px;color:var(--accent);white-space:nowrap">${d['Цена, руб.*'] ? Number(d['Цена, руб.*']).toLocaleString('ru') + ' ₽' : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-size:11.5px;color:var(--text3)" id="export-count-lbl"></div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" style="background:#005bff;border-color:#005bff" onclick="window.app.doExportOriginalOzon()">↓ В шаблоне Ozon</button>
       <button class="btn btn-primary" onclick="window.app.doExport()">↓ Обычный xlsx</button>`
    );

    setTimeout(() => {
      const tbody = document.getElementById('export-row-body');
      if (tbody) {
        tbody.addEventListener('mouseover', e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = 'var(--bg3)'; });
        tbody.addEventListener('mouseout', e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = ''; });
      }
      this.updateExportCount();
    }, 50);
  }

  updateExportCount() {
    const selCols = document.querySelectorAll('#export-col-sel .chk.on').length;
    const selRows = document.querySelectorAll('#export-row-body .exp-row.on').length;
    const lbl = document.getElementById('export-count-lbl');
    if (lbl) lbl.textContent = `Будет экспортировано: ${selRows} позиций × ${selCols} столбцов`;
    document.querySelectorAll<HTMLElement>('#export-row-body .exp-row').forEach(tr => {
      const box = tr.querySelector<HTMLElement>('.chk-box');
      const tick = tr.querySelector<HTMLElement>('.chk-tick');
      if (box && tick) {
        if (tr.classList.contains('on')) { box.style.background = 'var(--accent)'; box.style.borderColor = 'var(--accent)'; tick.style.display = 'block'; }
        else { box.style.background = 'var(--bg3)'; box.style.borderColor = ''; tick.style.display = 'none'; }
      }
    });
  }

  toggleAllExportCols(on: boolean) {
    document.querySelectorAll('#export-col-sel .chk').forEach(el => on ? el.classList.add('on') : el.classList.remove('on'));
    this.updateExportCount();
  }

  toggleAllExportRows(on: boolean) {
    document.querySelectorAll('#export-row-body .exp-row').forEach(el => on ? el.classList.add('on') : el.classList.remove('on'));
    this.updateExportCount();
  }

  doExport() {
    const selCols = [...document.querySelectorAll<HTMLElement>('#export-col-sel .chk.on')].map(el => el.dataset.ecol!);
    const selIds = new Set([...document.querySelectorAll<HTMLElement>('#export-row-body .exp-row.on')].map(el => el.dataset.prodId!));
    if (!selCols.length || !selIds.size) { this.app.toast('Выберите столбцы и позиции', 'error'); return; }
    const prods = (this.app.filtered.length ? this.app.filtered : this.app.allProducts).filter(p => selIds.has(p.id));
    const box = boxes.get().find(b => b.id === this.app.activeBoxId);
    const wsData = [selCols, ...prods.map(p => selCols.map(c => p.data[c] ?? ''))];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = selCols.map(c => ({ wch: Math.min(Math.max(c.length + 2, 12), 40) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Товары');
    const fname = `${box?.name || 'export'}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fname);
    this.app.toast(`Файл ${fname} скачан`, 'success');
    this.app.closeModal();
  }

  async doExportOriginalOzon() {
    const selIds = new Set([...document.querySelectorAll<HTMLElement>('#export-row-body .exp-row.on')].map(el => el.dataset.prodId!));
    if (!selIds.size) { this.app.toast('Выберите позиции для экспорта', 'error'); return; }

    if (!this.app.activeBoxId) { this.app.toast('Не выбрана группа', 'error'); return; }
    const box = boxes.get().find(b => b.id === this.app.activeBoxId);

    try {
      // Ищем импорты для текущей группы, чтобы достать оригинальный шаблон
      const sheets = await apiService.getSheetsByBox(this.app.activeBoxId);
      // Ищем последний импорт, у которого есть сохраненные template_headers
      const sheetWithHeaders = sheets.reverse().find(s => s.template_headers && s.template_headers.length > 0);

      if (!sheetWithHeaders || !sheetWithHeaders.template_headers) {
        this.app.toast('Оригинальный шаблон Ozon для этой группы не найден. Импортируйте шаблон заново.', 'error');
        return;
      }

      const prods = (this.app.filtered.length ? this.app.filtered : this.app.allProducts).filter(p => selIds.has(p.id));
      const fname = `${box?.name || 'export'}_ozon_original_${new Date().toISOString().slice(0, 10)}.xlsx`;

      if (sheetWithHeaders.template_file_b64) {
          try {
            this.app.toast('Подготовка шаблона (ExcelJS)...', 'info');

          const ExcelJS = await this.ensureExcelJS();

         // ИСПОЛЬЗУЕМ НАДЕЖНЫЙ СПОСОБ ДЕКОДИРОВАНИЯ
         const b64 = sheetWithHeaders.template_file_b64.replace(/\s/g, '');
         debug.log('Decoding Base64 template, length:', b64.length);
         const binaryString = atob(b64);
         const bytes = new Uint8Array(binaryString.length);
         for (let i = 0; i < binaryString.length; i++) {
             bytes[i] = binaryString.charCodeAt(i);
         }
         debug.log('Uint8Array created, size:', bytes.length);

         const workbook = new ExcelJS.Workbook();
         // Передаем Uint8Array напрямую - это более стабильно в браузерах
         await workbook.xlsx.load(bytes);
         debug.log('ExcelJS workbook loaded successfully');

         const ws = workbook.getWorksheet('Шаблон') || workbook.worksheets[0];
         if (!ws) throw new Error('Лист "Шаблон" не найден в оригинальном файле');

         // Авто-детект строки заголовков в шаблоне
         let headerRowNumber = 2;
         for (let r = 1; r <= 10; r++) {
            const row = ws.getRow(r);
            let found = false;
            row.eachCell({ includeEmpty: true }, (cell: import('exceljs').Cell) => {
               if (String(cell.value || '').includes('Артикул')) found = true;
            });
            if (found) { headerRowNumber = r; break; }
         }
         const headerRow = ws.getRow(headerRowNumber);
         const techRow = ws.getRow(headerRowNumber + 1);
         const columnCount = ws.actualColumnCount || ws.columnCount;
         const columnNames: string[] = [];
         const techKeys: string[] = [];
         for (let i = 1; i <= columnCount; i++) {
             const hVal = headerRow.getCell(i).value;
             const tVal = techRow.getCell(i).value;
             columnNames[i] = hVal ? String(hVal).trim() : '';
             techKeys[i] = tVal ? String(tVal).trim() : '';
         }

         const startDataRow = headerRowNumber + 3;

          const templateRow = ws.getRow(startDataRow);

           // Очистка старых данных перед записью новых (хирургическая, только значения)
           const maxRows = Math.max(ws.actualRowCount || 0, startDataRow + prods.length + 10);
           for (let r = startDataRow; r <= maxRows; r++) {
              const row = ws.getRow(r);
              row.eachCell({ includeEmpty: true }, (cell: import('exceljs').Cell) => {
                 cell.value = null;
              });
           }
           const originalViews = [...(ws.views || [])];
           const originalAutoFilter = ws.autoFilter;

          prods.forEach((p, idx) => {
             const rowNumber = startDataRow + idx;
             const row = ws.getRow(rowNumber);
             row.height = templateRow.height;

             for (let i = 1; i <= columnCount; i++) {
                const colName = columnNames[i];
                const techKey = techKeys[i];
                const val = (colName && p.data[colName] !== undefined) ? p.data[colName]
                          : (techKey && p.data[techKey] !== undefined) ? p.data[techKey]
                          : '';

                const cell = row.getCell(i);
                const tplCell = templateRow.getCell(i);

                cell.value = val;
                cell.style = tplCell.style;
                if (tplCell.dataValidation) {
                   cell.dataValidation = tplCell.dataValidation;
                }
             }
          });

          ws.views = originalViews;
          if (originalAutoFilter) ws.autoFilter = originalAutoFilter;

         const outBuffer = await workbook.xlsx.writeBuffer();
         const blob = new Blob([outBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
         const url = URL.createObjectURL(blob);
         const a = document.createElement('a');
         a.href = url;
         a.download = fname;
         a.click();
         URL.revokeObjectURL(url);

         this.app.toast(`Файл ${fname} скачан (с оригинальными стилями)`, 'success');
         this.app.closeModal();
            return;
         } catch (e: any) {
            console.error('ExcelJS OOM or Error:', e);
            this.app.toast('ExcelJS не справился, использую стандартный метод...', 'info');
         }
      }

      // РЕЗЕРВНЫЙ ВАРИАНТ (Если Base64 недоступен, например для старых импортов)
      const templateHeaders = sheetWithHeaders.template_headers; // any[][]
      const columnNamesRow = templateHeaders.length > 1 ? templateHeaders[1] : templateHeaders[0];
      const columnNames = columnNamesRow.map((c: any) => c ? String(c).trim() : null);

      const wsData: any[][] = [...templateHeaders];

      for (const p of prods) {
        const rowData = columnNames.map(colName => {
          if (!colName) return '';
          return p.data[colName] ?? '';
        });
        wsData.push(rowData);
      }

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws['!cols'] = columnNames.map(c => ({ wch: Math.min(Math.max((c || '').length + 2, 12), 40) }));
      XLSX.utils.book_append_sheet(wb, ws, 'Шаблон');
      XLSX.writeFile(wb, fname);
      this.app.toast(`Файл ${fname} скачан`, 'success');
      this.app.closeModal();
    } catch (e: any) {
      console.error(e);
      this.app.toast('Ошибка выгрузки: ' + String(e.stack || e.message || e), 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IMPORT
  // ─────────────────────────────────────────────────────────────────────────

  openImportModal() {
    const boxOptions = boxes.get().map(b => `<option value="${b.id}">${escHtml(b.sticker || '')} ${escHtml(b.name)}</option>`).join('');
    this.parsedImport = null;

    this.app.openModalLg('Импорт xlsx', 'Загрузите .xlsx — выберите формат и столбцы для импорта',
      `<div class="form-row">
        <div class="form-label">Формат файла</div>
        <select class="form-select" id="import-format" onchange="window.app.updateImportHint()">
          <option value="ozon">Ozon шаблон (строки 1,3,4 игнорируются, заголовки из строки 2)</option>
          <option value="yandex">Яндекс Маркет шаблон (лист «Данные о товарах», заголовки строка 4, данные с 8-й)</option>
          <option value="wb">WB шаблон (лист «Товары», заголовки строка 3, данные с 5-й)</option>
          <option value="system">Системный формат (заголовки из строки 1, данные со строки 2)</option>
        </select>
      </div>
      <div class="upload-zone" id="upload-zone" onclick="document.getElementById('file-inp').click()">
        <input type="file" id="file-inp" accept=".xlsx,.xls" onchange="window.app.onFileChosen(this)" style="display:none">
        <div class="upload-icon">⬆</div>
        <div class="upload-text">Перетащите .xlsx сюда или нажмите</div>
        <div class="upload-hint" id="import-hint">Строки 1, 3, 4 игнорируются · Заголовки из строки 2 · Данные с 5-й строки</div>
      </div>
      <div id="file-preview"></div>
      <div class="form-row" style="margin-top:14px">
        <div class="form-label">Группа для импорта</div>
        ${boxOptions
          ? `<select class="form-select" id="import-box-sel">${boxOptions}</select>`
          : `<div style="font-size:12px;color:var(--red)">Сначала создайте группу</div>`
        }
      </div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" id="import-btn" onclick="window.app.doImport()" disabled>Импортировать</button>`
    );

    if (this.app.activeBoxId) {
      setTimeout(() => {
        const sel = document.getElementById('import-box-sel') as HTMLSelectElement;
        if (sel) sel.value = this.app.activeBoxId!;
      }, 30);
    }
    this.setupDragDrop();
  }

  updateImportHint() {
    const format = (document.getElementById('import-format') as HTMLSelectElement)?.value || 'ozon';
    const hint = document.getElementById('import-hint');
    const text = format === 'ozon'
      ? 'Строки 1, 3, 4 игнорируются · Заголовки из строки 2 · Данные с 5-й строки'
      : format === 'yandex'
        ? 'Поддерживаются оба формата ЯМ: шаблон категории (лист «Данные о товарах») и экспорт (лист «Товары») · Служебные столбцы (ошибки, PARAM_NAMES) исключаются автоматически · Фото разбиваются на главное + дополнительные'
        : format === 'wb'
          ? 'Лист «Товары» · Заголовки из строки 3 · Данные с 5-й строки · «Артикул продавца» → Артикул · «Наименование» → Название товара · Фото (через «;») разбиваются автоматически'
          : 'Заголовки из строки 1 · Данные со строки 2';
    if (hint) hint.textContent = text;
  }

  private setupDragDrop() {
    const zone = document.getElementById('upload-zone');
    if (!zone) return;
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag');
      const f = e.dataTransfer?.files[0];
      if (f) this.processFile(f);
    });
  }

  onFileChosen(inp: HTMLInputElement) {
    if (inp.files?.[0]) this.processFile(inp.files[0]);
  }

  private processFile(file: File) {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const buffer = e.target!.result as ArrayBuffer;
        const wb = XLSX.read(buffer, { type: 'array' });
        const format = (document.getElementById('import-format') as HTMLSelectElement)?.value || 'ozon';
        let headers: (string | null)[], rows: any[][], templateHeaders: any[][] | undefined, template_file_b64: string | undefined;

        // Служебные столбцы ЯМ — не содержат данных товара
        const YM_SERVICE_COLS = new Set([
          'Критичные ошибки', 'Некритичные ошибки', 'Качество карточки',
          'Рекомендации по заполнению', 'CSKU на Маркете', 'Дата дополнения карточки',
          'PARAM_NAMES', 'PARAM_IDS',
        ]);

        // Сохраняем оригинальный файл в base64 для экспорта обратно в шаблон
        const saveB64 = () => {
          const u8 = new Uint8Array(buffer);
          let bin = '';
          const ch = 8192;
          for (let i = 0; i < u8.byteLength; i += ch) bin += String.fromCharCode.apply(null, u8.subarray(i, i + ch) as any);
          return btoa(bin);
        };

        // Разбивает колонку с фото (разделитель sep) → mainPhoto + доп. фото
        const splitPhotos = (hdrs: (string | null)[], rws: any[][], sep: string) => {
          const idx = hdrs.indexOf('Ссылка на главное фото*');
          if (idx === -1 || hdrs.includes('Ссылки на дополнительные фото')) return rws;
          hdrs.push('Ссылки на дополнительные фото');
          const extraIdx = hdrs.length - 1;
          return rws.map(row => {
            const urls = String(row[idx] || '').split(sep).map((u: string) => u.trim()).filter((u: string) => u.startsWith('http'));
            const r = [...row];
            r[idx] = urls[0] || '';
            r[extraIdx] = urls.slice(1).join('\n');
            return r;
          });
        };

        if (format === 'yandex') {
          // Поддерживаем оба формата ЯМ:
          // 1) Шаблон категории — лист «Данные о товарах», строка 4 = заголовки, строки 5-7 служебные, данные с 8-й
          // 2) Экспорт / упрощённый — лист «Товары», строка 1 = заголовки, данные со 2-й
          const sheetName = wb.SheetNames.find(n => /данные\s*о\s*товар/i.test(n))
            ?? wb.SheetNames.find(n => /товар/i.test(n))
            ?? wb.SheetNames[0];
          const ws = wb.Sheets[sheetName];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as any[][];

          // Авто-детект строки заголовков
          let headIdx = -1;
          let dataOffset = 1;

          // Сначала ищем «Ваш SKU» — признак шаблона загрузки (заголовки в строке 4+)
          for (let i = 0; i < Math.min(raw.length, 10); i++) {
            if ((raw[i] || []).some((c: any) => String(c ?? '').includes('Ваш SKU'))) {
              headIdx = i;
              dataOffset = 4; // пропускаем: коды параметров + пустая строка + описания
              break;
            }
          }

          // Иначе ищем любую строку с «Артикул» (экспорт / упрощённый формат)
          if (headIdx === -1) {
            for (let i = 0; i < Math.min(raw.length, 5); i++) {
              const row = raw[i] || [];
              const hasArt = row.some((c: any) => {
                const s = String(c ?? '').trim();
                return s === 'Артикул' || s === 'Ваш SKU *' || s === 'Артикул производителя';
              });
              if (hasArt) { headIdx = i; dataOffset = 1; break; }
            }
          }
          if (headIdx === -1) { headIdx = 0; dataOffset = 1; }

          headers = (raw[headIdx] || []).map((h: any) => {
            if (!h) return null;
            const s = String(h).trim();
            if (YM_SERVICE_COLS.has(s)) return null;
            if (s === 'Ваш SKU *' || s === 'Ваш SKU') return 'Артикул';
            if (s === 'Ссылка на изображение *') return 'Ссылка на главное фото*';
            if (s === 'Цена *') return 'Цена, руб.*';
            if (s === 'Название товара *') return 'Название товара *'; // уже норм
            return s;
          });

          rows = raw.slice(headIdx + dataOffset).filter((r: any[]) => r.some((c: any) => c !== null && c !== ''));
          templateHeaders = raw.slice(0, headIdx + dataOffset);
          rows = splitPhotos(headers, rows, ',');
          template_file_b64 = saveB64();

        } else if (format === 'wb') {
          // WB шаблон: лист «Товары», строки 1-2 = группировка разделов, строка 3 = заголовки, строка 4 = описания, данные с 5-й
          const sheetName = wb.SheetNames.find(n => /^товар/i.test(n)) ?? wb.SheetNames[0];
          const ws = wb.Sheets[sheetName];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as any[][];

          // Авто-детект: ищем строку с «Артикул продавца»
          let headIdx = 2; // обычно строка 3 (0-indexed: 2)
          for (let i = 0; i < Math.min(raw.length, 7); i++) {
            if ((raw[i] || []).some((c: any) => String(c ?? '').includes('Артикул продавца'))) {
              headIdx = i;
              break;
            }
          }

          headers = (raw[headIdx] || []).map((h: any) => {
            if (!h) return null;
            const s = String(h).trim();
            if (s === 'Артикул продавца') return 'Артикул';
            if (s === 'Наименование') return 'Название товара *';
            if (s === 'Фото') return 'Ссылка на главное фото*';
            if (s === 'Группа') return null; // порядковый номер, не нужен
            return s;
          });

          // dataOffset = 2: пропускаем строку описаний (строка 4)
          rows = raw.slice(headIdx + 2).filter((r: any[]) => r.some((c: any) => c !== null && c !== ''));
          templateHeaders = raw.slice(0, headIdx + 2);
          rows = splitPhotos(headers, rows, ';');
          template_file_b64 = saveB64();

        } else if (format === 'ozon') {
          const ws = wb.Sheets['Шаблон'] || wb.Sheets[wb.SheetNames[0]];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as any[][];

          // Улучшенный авто-детект: ищем строку, где есть "Артикул" (обычно 2-я или 3-я)
          let headIdx = -1;
          for (let i = 0; i < Math.min(raw.length, 10); i++) {
            if ((raw[i] || []).some(c => String(c || '').includes('Артикул'))) {
              headIdx = i;
              break;
            }
          }

          if (headIdx === -1) {
            this.app.toast('Это не похоже на шаблон Ozon (не найден столбец Артикул)', 'warning');
            headIdx = 1; // fallback
          }

          headers = (raw[headIdx] || []).map((h: any) => h ? String(h).trim() : null);
          // Данные обычно начинаются через 3 строки после заголовка (Заголовки -> Ключи -> Примеры -> Данные)
          rows = raw.slice(headIdx + 3).filter(r => r.some((c: any) => c !== null && c !== ''));
          templateHeaders = raw.slice(0, headIdx + 3);

          // СОХРАНЯЕМ ОРИГИНАЛЬНЫЙ ФАЙЛ
          const uint8Array = new Uint8Array(buffer);
          let binary = '';
          const chunk = 8192;
          for (let i = 0; i < uint8Array.byteLength; i += chunk) {
            binary += String.fromCharCode.apply(null, uint8Array.subarray(i, i + chunk) as any);
          }
          template_file_b64 = btoa(binary);

        } else {
          const ws = wb.Sheets['Шаблон'] || wb.Sheets[wb.SheetNames[0]];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as any[][];
          headers = (raw[0] || []).map((h: any) => h ? String(h).trim() : null);
          rows = raw.slice(1).filter(r => r.some((c: any) => c !== null && c !== ''));
        }

        if (!headers.filter(Boolean).length || !rows.length) { this.app.toast('Не удалось прочитать файл', 'error'); return; }
        this.parsedImport = { filename: file.name, headers: headers as string[], rows, format, templateHeaders, template_file_b64 };
        this.renderImportPreview();
      } catch (err: any) { this.app.toast('Ошибка: ' + err.message, 'error'); }
    };
    reader.readAsArrayBuffer(file);
  }

  private renderImportPreview() {
    if (!this.parsedImport) return;
    const { filename, headers, rows } = this.parsedImport;
    const nonNull = headers.map((h, i) => ({ h, i })).filter(x => x.h);
    const preview = document.getElementById('file-preview');
    if (!preview) return;

    preview.innerHTML = `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:12px;color:var(--text2)">✓ <strong style="color:var(--text)">${escHtml(filename)}</strong></span>
          <span style="font-size:11px;color:var(--text3)">${nonNull.length} столбцов · ${rows.length} товаров</span>
        </div>
      </div>
      <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите столбцы для импорта</div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllCols(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllCols(false)">Снять</button>
        </div>
      </div>
      <div id="col-selector" style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:16px;max-height:200px;overflow-y:auto;padding-right:4px">
        ${nonNull.map(({ h, i }) => {
          const isArt = h.includes('Артикул');
          // Считаем импорт "первым", если в текущей группе еще нет товаров
          const isFirstImport = this.app.allProducts.length === 0;
          const disabled = isArt || isFirstImport;
          return `
            <div class="chk on ${disabled ? 'disabled' : ''}" data-col-idx="${i}"
                 ${disabled ? 'style="opacity:0.6;cursor:not-allowed"' : 'onclick="this.classList.toggle(\'on\');window.app.updateImportCount()"'}
                 title="${disabled ? 'Обязательный столбец' : ''}">
              <div class="chk-box"><div class="chk-tick"></div></div>
              <span class="chk-label" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(h.replace('*', ''))}</span>
            </div>
          `;
        }).join('')}
      </div>
      <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите позиции для импорта</div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllRows(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllRows(false)">Снять</button>
        </div>
      </div>
      <div id="row-selector" style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="position:sticky;top:0;z-index:1">
            <th style="width:36px;padding:8px 10px;background:var(--bg4);border-bottom:1px solid var(--border)"></th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Артикул</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border)">Название</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Цена</th>
          </tr></thead>
          <tbody id="row-sel-body">
            ${rows.map((row, ri) => {
              const artIdx = headers.findIndex(h => h && h.includes('Артикул'));
              const nameIdx = headers.findIndex(h => h && h.includes('Название товара'));
              const priceIdx = headers.findIndex(h => h && h.includes('Цена, руб'));
              const art = artIdx >= 0 ? (row[artIdx] || '') : '';
              const name = nameIdx >= 0 ? (row[nameIdx] || '') : '';
              const price = priceIdx >= 0 ? (row[priceIdx] || '') : '';
              return `<tr class="row-sel-item on" data-row-idx="${ri}" onclick="this.classList.toggle('on');window.app.updateImportCount()" style="cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s">
                <td style="padding:8px 10px;text-align:center"><div class="chk-box" style="margin:0 auto"><div class="chk-tick"></div></div></td>
                <td style="padding:8px 10px;font-size:11px;color:var(--text3);white-space:nowrap">${escHtml(String(art))}</td>
                <td style="padding:8px 10px;font-size:12px;color:var(--text);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(String(name))}</td>
                <td style="padding:8px 10px;font-size:12px;color:var(--accent);white-space:nowrap">${price ? Number(price).toLocaleString('ru') + ' ₽' : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-size:11.5px;color:var(--text3)" id="import-count-label"></div>
    `;

    const rowBody = document.getElementById('row-sel-body');
    if (rowBody) {
      rowBody.addEventListener('mouseover', e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = 'var(--bg3)'; });
      rowBody.addEventListener('mouseout', e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = ''; });
    }
    this.updateImportCount();
    const importBtn = document.getElementById('import-btn') as HTMLButtonElement;
    if (importBtn) importBtn.disabled = false;
  }

  updateImportCount() {
    const selCols = document.querySelectorAll('#col-selector .chk.on').length;
    const selRows = document.querySelectorAll('#row-sel-body .row-sel-item.on').length;
    const lbl = document.getElementById('import-count-label');
    if (lbl) lbl.textContent = `Будет импортировано: ${selRows} позиций × ${selCols} столбцов`;
    document.querySelectorAll<HTMLElement>('#row-sel-body .row-sel-item').forEach(tr => {
      const box = tr.querySelector<HTMLElement>('.chk-box');
      const tick = tr.querySelector<HTMLElement>('.chk-tick');
      if (box && tick) {
        if (tr.classList.contains('on')) { box.style.background = 'var(--accent)'; box.style.borderColor = 'var(--accent)'; tick.style.display = 'block'; }
        else { box.style.background = 'var(--bg3)'; box.style.borderColor = ''; tick.style.display = 'none'; }
      }
    });
  }

  toggleAllCols(on: boolean) {
    document.querySelectorAll('#col-selector .chk').forEach(el => {
      if (!el.classList.contains('disabled')) {
        on ? el.classList.add('on') : el.classList.remove('on');
      }
    });
    this.updateImportCount();
  }

  toggleAllRows(on: boolean) {
    document.querySelectorAll('#row-sel-body .row-sel-item').forEach(el => on ? el.classList.add('on') : el.classList.remove('on'));
    this.updateImportCount();
  }

  async doImport() {
    if (!this.parsedImport) return;
    const boxSel = document.getElementById('import-box-sel') as HTMLSelectElement;
    if (!boxSel) { this.app.toast('Выберите группу', 'error'); return; }
    const boxId = boxSel.value;

    const selColIdxs = new Set([...document.querySelectorAll<HTMLElement>('#col-selector .chk.on')].map(el => parseInt(el.dataset.colIdx!)));
    const selRowIdxs = new Set([...document.querySelectorAll<HTMLElement>('#row-sel-body .row-sel-item.on')].map(el => parseInt(el.dataset.rowIdx!)));
    if (!selColIdxs.size) { this.app.toast('Выберите хотя бы один столбец', 'error'); return; }
    if (!selRowIdxs.size) { this.app.toast('Выберите хотя бы одну позицию', 'error'); return; }

    const btn = document.getElementById('import-btn') as HTMLButtonElement;
    if (btn) { btn.disabled = true; btn.textContent = 'Проверяю дубли...'; }

    try {
      const { filename, headers, rows } = this.parsedImport;
      const artIdx = headers.findIndex(h => h && h.includes('Артикул'));
      const existing = await apiService.getProductsByBox(boxId);
      const existingArts = new Set((existing || []).map(p => String(p.data?.['Артикул*'] || '').trim()).filter(Boolean));

      this.importCtx = { boxId, selColIdxs, selRowIdxs, filename, headers, rows, templateHeaders: this.parsedImport.templateHeaders, template_file_b64: this.parsedImport.template_file_b64, artIdx, existingArts, btn };

      const existingColumns = new Set<string>();
      (existing || []).forEach(p => {
        Object.keys(p.data || {}).forEach(k => {
          if (!k.startsWith('_')) existingColumns.add(k);
        });
      });
      const newColumns = headers.filter((h, i) => h && selColIdxs.has(i) && !existingColumns.has(h));

      if (newColumns.length > 0 && existing.length > 0) {
        if (btn) { btn.disabled = false; btn.textContent = 'Импортировать'; }
        this.app.openModal('Новые столбцы обнаружены', `В шаблоне есть ${newColumns.length} новых столбцов`,
          `<div style="background:var(--accent-dim);border:1px solid rgba(212,240,0,0.3);border-radius:8px;padding:14px 16px;margin-bottom:14px">
            <div style="font-size:12.5px;color:var(--text2);margin-bottom:8px">Новые столбцы:</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${newColumns.map(c => `<span style="font-family:monospace;font-size:11px;padding:2px 8px;background:var(--bg4);border:1px solid var(--border2);border-radius:4px;color:var(--text)">${escHtml(c.replace('*', ''))}</span>`).join('')}</div>
          </div>
          <div style="font-size:12.5px;color:var(--text2);margin-bottom:12px">Что делать с новыми столбцами?</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button class="btn" style="justify-content:flex-start" onclick="window.app.confirmImportWithNewColumns('all')">
              <span style="color:var(--accent)">✓</span> Импортировать все столбцы (новые и старые)
            </button>
            <button class="btn" style="justify-content:flex-start" onclick="window.app.confirmImportWithNewColumns('existing_only')">
              <span style="color:var(--text3)">○</span> Только столбцы которые были ранее
            </button>
          </div>`,
          `<button class="btn" onclick="window.app.closeModal()">Отмена</button>`
        );
        return;
      }

      await this.performImport(boxId, filename, headers, rows, selColIdxs, selRowIdxs, artIdx, existingArts, btn, 'all');
    } catch (e: any) {
      this.app.toast('Ошибка: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Импортировать'; }
    }
  }

  async confirmImportWithNewColumns(mode: 'all' | 'existing_only') {
    const ctx = this.importCtx;
    if (!ctx) return;
    this.app.closeModal();
    await this.performImport(ctx.boxId, ctx.filename, ctx.headers, ctx.rows, ctx.selColIdxs, ctx.selRowIdxs, ctx.artIdx, ctx.existingArts, ctx.btn, mode);
  }

  private async performImport(
    boxId: string, filename: string, headers: string[], rows: any[][],
    selColIdxs: Set<number>, selRowIdxs: Set<number>, artIdx: number,
    existingArts: Set<string>, btn: HTMLButtonElement | null, mode: 'all' | 'existing_only'
  ) {
    const templateHeaders = this.importCtx?.templateHeaders;
    // Existing columns for 'existing_only' mode
    let allowedCols: Set<string> | null = null;
    if (mode === 'existing_only') {
      const existing = await apiService.getProductsByBox(boxId);
      const cols = new Set<string>();
      (existing || []).forEach(p => {
        Object.keys(p.data || {}).forEach(k => {
          if (!k.startsWith('_')) cols.add(k);
        });
      });
      allowedCols = cols;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Импортирую...'; }

    try {
      // Create sheet record
      const selHeaders = headers.filter((h, i) => h && selColIdxs.has(i));
      const template_file_b64 = this.importCtx?.template_file_b64;
      void await apiService.createSheet({ box_id: boxId, filename, columns: selHeaders, template_headers: templateHeaders, template_file_b64 });

      const selectedRows = rows.filter((_, ri) => selRowIdxs.has(ri));

      // Check duplicates
      const newRows: any[] = [];
      const updateRows: any[] = [];
      for (const row of selectedRows) {
        const art = artIdx >= 0 ? String(row[artIdx] || '').trim() : '';
        const data: Record<string, any> = {};
        headers.forEach((h, i) => {
          if (!h || !selColIdxs.has(i)) return;
          if (allowedCols && !allowedCols.has(h)) return;
          data[h] = row[i] ?? '';
        });
        if (art && existingArts.has(art)) updateRows.push({ art, data });
        // Артикулы не из группы — не добавляем, считаем пропущенными
      }

      void selectedRows.length; // skipped count computed below
      const unknownCount = selectedRows.filter(row => {
        const art2 = artIdx >= 0 ? String(row[artIdx] || '').trim() : '';
        return art2 && !existingArts.has(art2);
      }).length;

      // Обновляем только существующие товары
      if (updateRows.length > 0) {
        const msg = `${updateRows.length} товаров найдено в группе. Обновить их данные?`;
        if (confirm(msg)) {
          const existing = await apiService.getProductsByBox(boxId);
          for (const { art, data } of updateRows) {
            const prod = existing.find(p => String(p.data?.['Артикул*'] || '').trim() === art);
            if (prod) await apiService.updateProduct(prod.id, { data });
          }
        }
      }

      // Предупреждение о пропущенных
      if (unknownCount > 0) {
        setTimeout(() => {
          this.app.toast(
            `⚠ ${unknownCount} артикул(ов) из файла не найдено в группе — пропущены и не добавлены. xlsx-добавка дополняет только существующие товары.`,
            'info', 8000
          );
        }, 500);
      }

      this.app.toast(`Импортировано: ${newRows.length} новых, ${updateRows.length} обновлено`, 'success', 4000);
      this.app.cache.delete(boxId);
      idbCache.remove(boxId).catch(() => {});
      // Сбрасываем сохранённый порядок столбцов — при следующем рендере применится новый приоритет
      this.app.columnOrder.delete(boxId);

      // Автоскрытие пустых столбцов: импортируем все (для экспорта обратно в шаблон),
      // но скрываем в таблице те, где у всех товаров пустые значения
      if (this.app.activeBoxId === boxId) {
        const importedHeaders = headers.filter((h, i) => h && selColIdxs.has(i)) as string[];
        const emptyCols = new Set(importedHeaders.filter(h => {
          const colIdx = headers.indexOf(h);
          return selectedRows.every(row => {
            const v = row[colIdx];
            return v === null || v === undefined || String(v).trim() === '';
          });
        }));
        if (emptyCols.size > 0) {
          const visibleSet = new Set(importedHeaders.filter(h => !emptyCols.has(h)));
          this.app.visibleCols = visibleSet.size > 0 ? visibleSet : null;
          try { localStorage.setItem(`vis_cols_${boxId}`, JSON.stringify([...visibleSet])); } catch {}
        }
      }
      try {
        const co: Record<string, string[]> = {};
        for (const [bid, cls] of this.app.columnOrder) co[bid] = cls;
        localStorage.setItem('app_column_order', JSON.stringify(co));
      } catch {}
      this.app.closeModal();
      this.app.loadBoxCount(boxId);
      if (this.app.activeBoxId === boxId) await this.app.loadBoxProducts();
    } catch (e: any) {
      this.app.toast('Ошибка импорта: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Импортировать'; }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXPORT ALL TO EXCEL
  // ─────────────────────────────────────────────────────────────────────────

  exportAllToExcel() {
    // Берём все товары из allProducts (уже загружены в «Все товары»)
    const prods = this.app.allProducts;
    if (!prods.length) {
      this.app.toast('Нет данных для экспорта', 'error');
      return;
    }

    // Собираем все ключи по всем товарам, исключая служебные поля
    const colSet = new Set<string>();
    prods.forEach(p => {
      Object.keys(p.data || {}).forEach(k => {
        if (!k.startsWith('_')) colSet.add(k);
      });
    });
    const cols = [...colSet];

    const rows: (string | number | undefined)[][] = [cols];
    for (const p of prods) {
      rows.push(cols.map(c => p.data[c] ?? ''));
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = cols.map(c => ({ wch: Math.min(Math.max(c.length + 2, 12), 40) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Товары');

    const today = new Date().toISOString().slice(0, 10);
    const fname = `simadesk_all_${today}.xlsx`;
    XLSX.writeFile(wb, fname);
    this.app.toast(`Скачано ${prods.length} товаров → ${fname}`, 'success');
  }

  openExportModalAll() {
    const prods = this.app.filtered.length ? this.app.filtered : this.app.allProducts;
    if (!prods.length) { this.app.toast('Нет товаров для экспорта', 'error'); return; }

    // Собираем все уникальные колонки по всем товарам
    const colSet = new Set<string>();
    prods.forEach(p => Object.keys(p.data || {}).forEach(k => { if (!k.startsWith('_')) colSet.add(k); }));
    const allCols = [...colSet];

    this.app.openModalLg('Экспорт — Все товары', `${prods.length} товаров`,
      `<div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите столбцы для экспорта</div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportCols(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportCols(false)">Снять</button>
        </div>
      </div>
      <div id="export-col-sel" style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:16px;max-height:140px;overflow-y:auto;padding-right:4px">
        ${allCols.map(c => `
          <div class="chk on" data-ecol="${escHtml(c)}" onclick="this.classList.toggle('on');window.app.updateExportCount()">
            <div class="chk-box"><div class="chk-tick"></div></div>
            <span class="chk-label" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(c)}">${escHtml(c.replace('*',''))}</span>
          </div>`).join('')}
      </div>
      <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите позиции для экспорта</div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportRows(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportRows(false)">Снять</button>
        </div>
      </div>
      <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="width:36px;padding:8px 10px;background:var(--bg4);border-bottom:1px solid var(--border)"></th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Артикул</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border)">Название</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Группа</th>
          </tr></thead>
          <tbody id="export-row-body">
            ${prods.map(p => {
              const d = p.data || {};
              const boxName = boxes.get().find(b => b.id === p.box_id)?.name ?? '—';
              return `<tr class="exp-row on" data-prod-id="${p.id}" onclick="this.classList.toggle('on');window.app.updateExportCount()" style="cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s">
                <td style="padding:8px 10px;text-align:center"><div class="chk-box" style="margin:0 auto"><div class="chk-tick"></div></div></td>
                <td style="padding:8px 10px;font-size:11px;color:var(--text3);white-space:nowrap">${escHtml(d['Артикул*'] || d['Артикул'] || '')}</td>
                <td style="padding:8px 10px;font-size:12px;color:var(--text);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(d['Название товара'] || d['Название товара*'] || '')}</td>
                <td style="padding:8px 10px;font-size:11px;color:var(--muted);white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis">${escHtml(boxName)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-size:11.5px;color:var(--text3)" id="export-count-lbl"></div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.doExportAll()">↓ Скачать xlsx</button>`
    );

    setTimeout(() => {
      const tbody = document.getElementById('export-row-body');
      if (tbody) {
        tbody.addEventListener('mouseover', e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = 'var(--bg3)'; });
        tbody.addEventListener('mouseout',  e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = ''; });
      }
      this.updateExportCount();
    }, 50);
  }

  doExportAll() {
    const selCols = [...document.querySelectorAll<HTMLElement>('#export-col-sel .chk.on')].map(el => el.dataset.ecol!);
    const selIds  = new Set([...document.querySelectorAll<HTMLElement>('#export-row-body .exp-row.on')].map(el => el.dataset.prodId!));
    if (!selCols.length || !selIds.size) { this.app.toast('Выберите столбцы и позиции', 'error'); return; }

    const prods = (this.app.filtered.length ? this.app.filtered : this.app.allProducts).filter(p => selIds.has(p.id));
    const wsData = [selCols, ...prods.map(p => selCols.map(c => p.data[c] ?? ''))];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = selCols.map(c => ({ wch: Math.min(Math.max(c.length + 2, 12), 40) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Товары');
    const fname = `simadesk_all_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fname);
    this.app.toast(`Файл ${fname} скачан`, 'success');
    this.app.closeModal();
  }
}
