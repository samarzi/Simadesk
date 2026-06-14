import { debug } from '@/utils/debug';
import { boxes, boxActions } from '../stores/appStore';
import { apiService } from '../services/api';
import { esc as escHtml } from '../utils/format';
import { App } from '../App';
import { I } from '@/utils/icons';

/** Массовые операции с товарами, синхронизация каталога с МП, массовое заполнение колонки. */
export class MassActionsModule {
  constructor(private app: App) {}

  // ── MASS ACTIONS ─────────────────────────────────────────────────────────

  massDeleteProducts() {
    if (this.app.selectedProducts.size === 0) return;
    this.app.openModal('Удалить выбранные товары?', `Будет удалено товаров: ${this.app.selectedProducts.size}`,
      `<div style="font-size:13px;color:var(--text2);margin-bottom:10px">Это действие нельзя отменить.</div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-danger" onclick="window.app.doMassDelete()">Удалить</button>`
    );
  }

  async doMassDelete() {
    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-danger');
    if (btn) { btn.disabled = true; btn.textContent = 'Удаляю...'; }
    try {
      const ids = Array.from(this.app.selectedProducts);
      // Удаляем по одному
      for (const id of ids) {
        await apiService.deleteProduct(id);
      }
      this.app.cache.delete(this.app.activeBoxId!);
      await this.app.loadBoxProducts();
      this.app.selectedProducts.clear();
      this.app.renderActionBar();
      this.app.closeModal();
      this.app.toast(`Удалено товаров: ${ids.length}`, 'success');
    } catch (e: any) { this.app.toast('Ошибка удаления: ' + e.message, 'error'); }
  }

  massHideProducts(hide: boolean) {
    if (this.app.selectedProducts.size === 0) return;

    const selectedProds = this.app.allProducts.filter(p => this.app.selectedProducts.has(p.id));

    selectedProds.forEach(p => {
      let set = this.app.hiddenRows.get(p.box_id);
      if (!set) {
        set = new Set();
        this.app.hiddenRows.set(p.box_id, set);
      }
      if (hide) set.add(p.id);
      else set.delete(p.id);
    });

    // Save to localStorage
    const obj: any = {};
    this.app.hiddenRows.forEach((set, boxId) => {
      if (set.size > 0) obj[boxId] = Array.from(set);
    });
    localStorage.setItem('app_hidden_rows', JSON.stringify(obj));

    this.app.applyFilters();
    this.app.renderProducts();
    this.app.renderActionBar();
    this.app.toast(hide ? 'Товары скрыты' : 'Товары показаны', 'success');
  }

  massMoveProducts() {
    if (this.app.selectedProducts.size === 0) return;
    const allBoxes = boxes.get().filter(b => b.id !== this.app.activeBoxId);
    if (allBoxes.length === 0) {
      this.app.toast('Нет других групп для перемещения', 'error');
      return;
    }
    const opts = allBoxes.map(b => `<option value="${b.id}">${escHtml(b.sticker || '')} ${escHtml(b.name)}</option>`).join('');

    this.app.openModal('Переместить товары', `Выберите группу для ${this.app.selectedProducts.size} товаров:`,
      `<select id="mass-move-box" class="form-select">${opts}</select>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.doMassMove()">Переместить</button>`
    );
  }

  async doMassMove() {
    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Перемещаю...'; }
    const targetBoxId = (document.getElementById('mass-move-box') as HTMLSelectElement).value;
    try {
      const ids = Array.from(this.app.selectedProducts);
      for (const id of ids) {
        await apiService.updateProduct(id, { box_id: targetBoxId });
      }
      this.app.cache.delete(this.app.activeBoxId!);
      this.app.cache.delete(targetBoxId);
      await this.app.loadBoxProducts();
      this.app.selectedProducts.clear();
      this.app.renderActionBar();
      this.app.closeModal();
      this.app.toast(`Перемещено товаров: ${ids.length}`, 'success');
    } catch (e: any) { this.app.toast('Ошибка перемещения: ' + e.message, 'error'); }
  }

  openMassEditModal() {
    if (this.app.selectedProducts.size === 0) return;
    const prods = this.app.allProducts.filter(p => this.app.selectedProducts.has(p.id));

    // Показываем видимые сейчас столбцы
    const allCols = this.app.columns.filter(c => !App.SKIP_COLS.has(c));
    const editCols = this.app.visibleCols ? allCols.filter(c => this.app.visibleCols!.has(c)) : allCols;

    let rowsHtml = '';
    for (const p of prods) {
      rowsHtml += `<tr data-id="${p.id}" class="mass-edit-row">`;
      for (const col of editCols) {
        const val = escHtml(String(p.data[col] || ''));
        const readonly = col.includes('Артикул'); // артикул менять нельзя, он ключ
        rowsHtml += `
          <td style="padding:4px;border:1px solid var(--border)">
            <input type="text" class="form-input" data-col="${escHtml(col)}" value="${val}" ${readonly ? 'disabled style="background:var(--bg2);opacity:0.7;padding:4px 6px;height:28px;font-size:12px;border:none"' : 'style="padding:4px 6px;height:28px;font-size:12px;border:none;background:transparent"'} />
          </td>
        `;
      }
      rowsHtml += `</tr>`;
    }

    const tableHtml = `
      <div style="overflow-x:auto;max-height:60vh;overflow-y:auto;border:1px solid var(--border);border-radius:6px;background:var(--bg2)">
        <table style="width:100%;border-collapse:collapse;min-width:600px">
          <thead style="position:sticky;top:0;z-index:2;background:var(--bg3)">
            <tr>
              ${editCols.map(c => `<th style="padding:6px;text-align:left;font-size:11px;color:var(--text3);border:1px solid var(--border);white-space:nowrap">${escHtml(c.replace('*', ''))}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--text2)">ℹ Отредактируйте ячейки и нажмите Сохранить. Привязанные товары обновятся и на Ozon!</div>
    `;

    this.app.openModalLg('Массовое редактирование', `${prods.length} товаров`,
      tableHtml,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.doMassEditSave()">Сохранить изменения</button>`
    );
  }

  async doMassEditSave() {
    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Сохранение...'; }

    try {
      const rows = document.querySelectorAll('.mass-edit-row');
      let updatedCount = 0;

      const box = boxes.get().find(b => b.id === this.app.activeBoxId);
      const isOzonLinked = !!box?.ozon_store_id;

      for (const row of rows) {
        const id = (row as HTMLElement).dataset.id!;
        const prod = this.app.allProducts.find(p => p.id === id);
        if (!prod) continue;

        let changed = false;
        const newData = { ...prod.data };

        const inputs = row.querySelectorAll('input');
        for (const inp of inputs) {
          const col = inp.dataset.col!;
          const val = inp.value;
          if (newData[col] !== val && !col.includes('Артикул')) {
            newData[col] = val;
            changed = true;
          }
        }

        if (changed) {
          await apiService.updateProduct(id, { data: newData });
          prod.data = newData;
          updatedCount++;

          // Синхронизация с Ozon при сохранении
          if (isOzonLinked && newData['_ozon_synced_at']) {
            await this.app.pushProductToOzon(id, newData, box!);
          }
        }
      }

      if (updatedCount > 0) {
        this.app.cache.delete(this.app.activeBoxId!);
        if (this.app.viewMode === 'table') this.app.vtPaint();
        else this.app.renderCards(document.getElementById('list-content')!);
        this.app.toast(`Обновлено товаров: ${updatedCount}`, 'success');
      } else {
        this.app.toast('Нет изменений', 'info');
      }
      this.app.closeModal();
    } catch (e: any) {
      this.app.toast('Ошибка сохранения: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить изменения'; }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MP CATALOG SYNC — автосинхронизация товаров из Ozon / ЯМ
  // ─────────────────────────────────────────────────────────────────────────

  /** Открыть диалог выбора магазина для автосинхронизации */
  async openMpSyncModal() {
    // Загружаем магазины Ozon и ЯМ
    const { ozonDb } = await import('../services/ozonDb');
    const { yandexDb } = await import('../services/yandexDb');
    const cid = (await import('../services/companyService')).companyService.getActiveId();
    if (!cid) { this.app.toast('Нет активной компании', 'error'); return; }

    const { wbDb } = await import('../services/wbDb');
    const [allOzon, allYm, allWb] = await Promise.all([ozonDb.getStores(), yandexDb.getStores(), wbDb.getStores()]);
    const ozonStores: any[] = (allOzon as any[]).filter((s: any) => s.company_id === cid || !s.company_id);
    const ymStores:   any[] = (allYm   as any[]).filter((s: any) => s.company_id === cid || !s.company_id);
    const wbStores:   any[] = (allWb   as any[]).filter((s: any) => s.company_id === cid || !s.company_id);

    if (!ozonStores.length && !ymStores.length && !wbStores.length) {
      this.app.openModal(
        `${I.refresh('', 16)} Синхронизация с маркетплейсом`,
        'Нет подключённых магазинов',
        `<div style="padding:20px 0;text-align:center;color:var(--muted);font-size:13px">
          Сначала подключите магазин в разделе <b>Настройки → Маркетплейсы</b>.
        </div>`,
        `<button class="btn" onclick="window.app.closeModal()">Закрыть</button>`,
      );
      return;
    }

    // Текущие синхронизированные группы
    const syncedBoxes = boxes.get().filter(b => b.mp_source);
    const syncedMap = new Map(syncedBoxes.map(b => [b.mp_store_id, b]));

    const renderRow = (icon: string, label: string, source: string, s: any) => {
      const synced = syncedMap.get(s.id);
      const lastSync = synced?.mp_last_sync
        ? new Date(synced.mp_last_sync).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : null;

      // Для WB — проверяем кулдаун из localStorage прямо здесь
      let cooldownBanner = '';
      if (source === 'wb') {
        try {
          const stored = JSON.parse(localStorage.getItem('wb_cooldown_until_v2') || '{}');
          const until = Math.max(...Object.values(stored as Record<string, number>).map(Number), 0);
          const secLeft = Math.ceil((until - Date.now()) / 1000);
          if (secLeft > 0) {
            const minLeft = Math.ceil(secLeft / 60);
            cooldownBanner =           `<div style="font-size:11px;color:#b45309;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;padding:4px 8px;margin-top:4px">
              ${I.hourglass('', 14)} WB заблокировал запросы ещё ~${minLeft} мин.
              <button onclick="event.stopPropagation();window.app.clearWbCooldownAndSync('wb','${s.id}',this.closest('.mp-sync-row').querySelector('button.btn-primary'))"
                style="margin-left:8px;padding:2px 8px;border:1px solid #b45309;background:transparent;color:#b45309;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600">
                Сбросить и попробовать
              </button>
            </div>`;
          }
        } catch (e) { debug.warn('[MassActionsModule] swallowed error', e); }
      }

      return `
        <div class="mp-sync-row" style="display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px">
          <div style="font-size:22px">${icon}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px">${label}: ${escHtml(s.name)}</div>
            <div style="font-size:11px;color:var(--muted)">${lastSync ? `Синхр. ${lastSync}` : 'Ещё не синхронизировано'}</div>
            ${cooldownBanner}
          </div>
          <button class="btn btn-primary" style="font-size:12px;padding:6px 14px;white-space:nowrap"
            onclick="window.app.runMpSync('${source}','${s.id}',this)">
            ${synced ? '↻ Обновить' : '↓ Загрузить'}
          </button>
        </div>`;
    };

    const storeRows = [
      ...ozonStores.map((s: any) => renderRow(I.ozon('', 16), 'Ozon', 'ozon', s)),
      ...ymStores.map((s: any)   => renderRow(I.yandex('', 16), 'ЯМ',   'ym',   s)),
      ...wbStores.map((s: any)   => renderRow(I.wb('', 16), 'WB',   'wb',   s)),
    ].join('');

    this.app.openModal(
      `${I.refresh('', 16)} Синхронизация с маркетплейсом`,
      'Загружает все товары со всеми атрибутами — как импорт шаблона, но автоматически',
      `<div>
        ${storeRows}
        <div id="mp-sync-progress" style="display:none;margin-top:12px;padding:12px;background:var(--bg2);border-radius:8px;font-size:12px">
          <div id="mp-sync-stage" style="color:var(--text2);margin-bottom:6px"></div>
          <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
            <div id="mp-sync-bar" style="height:100%;background:var(--accent);border-radius:3px;width:0%;transition:width .3s"></div>
          </div>
          <div id="mp-sync-count" style="color:var(--muted);margin-top:4px;text-align:right"></div>
        </div>
        <div style="margin-top:12px;padding:10px;background:var(--bg2);border-radius:8px;font-size:11px;color:var(--muted);line-height:1.6">
          ℹ WB подтягивает карточки через Content API (название, фото, цена, остатки).<br>
          При повторной синхронизации существующие товары <b>обновляются</b>, новые <b>добавляются</b>.
        </div>
      </div>`,
      `<button class="btn" id="mp-sync-close-btn" onclick="window.app.closeModal()">Закрыть</button>`,
    );
  }

  /** Запустить синхронизацию конкретного магазина */
  async runMpSync(source: 'ozon' | 'ym' | 'wb', storeId: string, btn: HTMLButtonElement) {
    // Блокируем все кнопки на время синхронизации
    document.querySelectorAll<HTMLButtonElement>('.mp-sync-row button').forEach(b => { b.disabled = true; });
    btn.innerHTML = `${I.hourglass('', 14)} Загружаем...`;

    const progressEl = document.getElementById('mp-sync-progress');
    const stageEl = document.getElementById('mp-sync-stage');
    const barEl = document.getElementById('mp-sync-bar');
    const countEl = document.getElementById('mp-sync-count');
    if (progressEl) progressEl.style.display = 'block';

    const onProgress = (p: { stage: string; done: number; total: number }) => {
      if (stageEl) stageEl.textContent = p.stage;
      if (barEl) barEl.style.width = p.total > 0 ? `${Math.round((p.done / p.total) * 100)}%` : '10%';
      if (countEl) countEl.textContent = p.total > 0 ? `${p.done} / ${p.total}` : '';
    };

    try {
      const { syncOzonStore, syncYandexStore, syncWbStore } = await import('../services/mpCatalogSync');

      let result: any;
      if (source === 'ozon') {
        const { ozonDb } = await import('../services/ozonDb');
        const stores = await ozonDb.getStores();
        const store = (stores as any[]).find((s: any) => s.id === storeId);
        if (!store) throw new Error('Магазин Ozon не найден');
        result = await syncOzonStore(store, onProgress);
      } else if (source === 'ym') {
        const { yandexDb } = await import('../services/yandexDb');
        const ymList = await yandexDb.getStores();
        const store = (ymList as any[]).find((s: any) => s.id === storeId);
        if (!store) throw new Error('Магазин ЯМ не найден');
        result = await syncYandexStore(store, onProgress);
      } else {
        const { wbDb } = await import('../services/wbDb');
        const wbList = await wbDb.getStores();
        const store = (wbList as any[]).find((s: any) => s.id === storeId);
        if (!store) throw new Error('Магазин WB не найден');
        result = await syncWbStore(store, onProgress);
      }

      if (stageEl) stageEl.innerHTML = `${I.checkCircle('', 16)} Синхронизация завершена!`;
      if (barEl) barEl.style.width = '100%';
      if (countEl) countEl.textContent = `Добавлено: ${result.created}, обновлено: ${result.updated}`;

      // Обновляем список групп
      await boxActions.loadBoxes();
      this.app.renderBoxes();

      this.app.toast(`${I.checkCircle('', 16)} ${result.boxName}: ${result.created} добавлено, ${result.updated} обновлено`, 'success', 5000);

      // Переходим в синхронизированную группу
      if (result.boxId) {
        setTimeout(async () => {
          this.app.closeModal();
          await this.app.selectBox(result.boxId);
        }, 1500);
      }
    } catch (e: any) {
      const isRateLimit = /429|rate.?limit|rate-limited/i.test(e.message ?? '');
      if (stageEl) {
        if (isRateLimit && source === 'wb') {
          stageEl.innerHTML = `${I.xCircle('', 16)} WB заблокировал запросы (лимит 429). Подождите пару минут или сбросьте блокировку.<br>
            <button id="wb-clear-cooldown-btn" style="margin-top:8px;padding:6px 14px;border:1.5px solid var(--accent);background:var(--accent-pale,#fff8e1);color:var(--text);border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">
              ${I.lock} Сбросить блокировку и повторить
            </button>`;
          document.getElementById('wb-clear-cooldown-btn')?.addEventListener('click', () => {
            this.clearWbCooldownAndSync(source, storeId, btn);
          });
        } else {
          stageEl.innerHTML = `${I.xCircle('', 16)} Ошибка: ${e.message}`;
        }
      }
      if (barEl) barEl.style.color = 'var(--red)';
      this.app.toast('Ошибка синхронизации: ' + e.message, 'error', 6000);
      document.querySelectorAll<HTMLButtonElement>('.mp-sync-row button').forEach(b => { b.disabled = false; });
      btn.textContent = '↻ Повторить';
    }
  }

  async clearWbCooldownAndSync(source: 'ozon' | 'ym' | 'wb', storeId: string, btn: HTMLButtonElement) {
    const { clearWbCooldown } = await import('../services/wbApi');
    clearWbCooldown();
    const stageEl = document.getElementById('mp-sync-stage');
    if (stageEl) stageEl.innerHTML = `${I.lock('', 16)} Блокировка снята. Запускаем синхронизацию...`;
    await this.runMpSync(source, storeId, btn);
  }

  // МАССОВОЕ ЗАПОЛНЕНИЕ КОЛОНКИ (доступно внутри редактора)
  // ─────────────────────────────────────────────────────────────────────────

  openMassFillModal() {
    if (!this.app.allProducts.length) return;

    // Собираем все колонки (исключая служебные)
    const SKIP = new Set(['Артикул*','Артикул','_ozon_store_id','_ym_store_id']);
    const colSet = new Set<string>();
    this.app.allProducts.forEach(p => {
      Object.keys(p.data || {}).forEach(k => {
        if (!k.startsWith('_') && !SKIP.has(k)) colSet.add(k);
      });
    });
    const cols = Array.from(colSet).sort();

    const target = this.app.selectedProducts.size > 0
      ? `выбранных ${this.app.selectedProducts.size} товаров`
      : `всех ${this.app.filtered.length} товаров`;

    this.app.openModalLg('Заполнить колонку',
      `Применить одно значение для ${target}`,
      `<div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;font-weight:600">Колонка</div>
          <select id="mf-col" class="form-select" style="width:100%">
            ${cols.map(c => `<option value="${escHtml(c)}">${escHtml(c.replace('*',''))}</option>`).join('')}
          </select>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;font-weight:600">Значение</div>
          <input id="mf-val" class="form-input" placeholder="Введите значение..." autofocus>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
            <input type="radio" name="mf-mode" value="all" checked> Применить ко всем отфильтрованным (${this.app.filtered.length})
          </label>
          ${this.app.selectedProducts.size > 0 ? `
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
            <input type="radio" name="mf-mode" value="selected"> Только выбранным (${this.app.selectedProducts.size})
          </label>` : ''}
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
            <input type="radio" name="mf-mode" value="empty"> Только пустым полям
          </label>
        </div>
        <div style="font-size:11px;color:var(--muted);padding:8px;background:var(--bg2);border-radius:6px;line-height:1.5">
          ℹ Изменения сохранятся в SimaDesk. Если группа синхронизирована с маркетплейсом — данные также отправятся туда.
        </div>
      </div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.applyMassFill()">✓ Применить</button>`
    );
    setTimeout(() => (document.getElementById('mf-val') as HTMLInputElement)?.focus(), 50);
  }

  async applyMassFill() {
    const colEl  = document.getElementById('mf-col') as HTMLSelectElement;
    const valEl  = document.getElementById('mf-val') as HTMLInputElement;
    const modeEl = document.querySelector<HTMLInputElement>('input[name="mf-mode"]:checked');
    if (!colEl || !valEl || !modeEl) return;

    const col   = colEl.value;
    const value = valEl.value;
    const mode  = modeEl.value as 'all' | 'selected' | 'empty';
    if (!col) { this.app.toast('Выберите колонку', 'error'); return; }

    let targets = this.app.filtered;
    if (mode === 'selected' && this.app.selectedProducts.size > 0) {
      targets = this.app.filtered.filter(p => this.app.selectedProducts.has(p.id));
    } else if (mode === 'empty') {
      targets = this.app.filtered.filter(p => {
        const v = (p.data || {})[col];
        return v === undefined || v === null || v === '';
      });
    }

    if (!targets.length) { this.app.toast('Нет подходящих товаров', 'info'); return; }

    const btn = document.querySelector<HTMLButtonElement>('.btn.btn-primary');
    if (btn) { btn.disabled = true; btn.innerHTML = `${I.hourglass('', 14)} Применяем...`; }

    let done = 0;
    const CHUNK = 50;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const batch = targets.slice(i, i + CHUNK);
      await Promise.all(batch.map(async p => {
        const newData = { ...(p.data || {}), [col]: value };
        await apiService.updateProduct(p.id, { data: newData });
        p.data = newData;
        done++;
      }));
    }

    this.app.toast(`${I.checkCircle('', 16)} Заполнено ${done} товаров: «${col.replace('*','')}» = «${value}»`, 'success', 5000);
    this.app.closeModal();
    this.app.buildColumns();
    this.app.applyFilters();
    if (this.app.viewMode === 'table') this.app.vtPaint();
    else this.app.renderCards(document.getElementById('list-content')!);
  }
}
