import { boxes, boxActions } from '../stores/appStore';
import { apiService } from '../services/api';
import { idbCache } from '../services/idbCache';
import { esc as escHtml, extractFirstEmoji } from '../utils/format';
import type { App } from '../App';

export class BoxModalsModule {
  constructor(private app: App) {}

  // ─────────────────────────────────────────────────────────────────────────
  // BOX MODALS — CREATE
  // ─────────────────────────────────────────────────────────────────────────

  openNewBoxModal() {
    this.app.openModal('Новая группа', 'Назовите группу для ваших товаров',
      `<div class="form-row">
        <div class="form-label">Название группы</div>
        <input class="form-input" id="new-box-name" placeholder="Например: Кровати май, Комоды 2025…" autofocus>
      </div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.createBox()">Создать</button>`
    );
    setTimeout(() => (document.getElementById('new-box-name') as HTMLInputElement)?.focus(), 50);
  }

  async createBox() {
    const nameEl = document.getElementById('new-box-name') as HTMLInputElement;
    const name = nameEl?.value?.trim();
    if (!name) { this.app.toast('Введите название', 'error'); return; }
    try {
      const box = await apiService.createBox({ name, sticker: '📦' });
      boxActions.addBox(box);
      this.app.renderBoxes();
      this.app.closeModal();
      this.app.toast(`Группа «${name}» создана`, 'success');
      await this.app.selectBox(box.id);
    } catch (e: any) { this.app.toast('Ошибка: ' + e.message, 'error'); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOX MODALS — RENAME (with emoji picker)
  // ─────────────────────────────────────────────────────────────────────────

  renameBox(id: string, currentName: string) {
    const box = boxes.get().find(b => b.id === id);
    const current = box?.sticker || '📦';
    const isApple = /iPhone|iPad|Mac/.test(navigator.userAgent);
    const isWin   = /Win/.test(navigator.userAgent);
    const shortcut = isApple ? '⌃⌘Space' : isWin ? 'Win + .' : 'системный выбор эмодзи';

    this.app.openModal('Настройки группы', '',
      `<div style="display:flex;gap:12px;align-items:flex-start">
        <!-- Эмодзи -->
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <div id="rb-emoji-display"
            style="width:56px;height:56px;border-radius:12px;background:var(--bg2);border:2px solid var(--border);
                   display:flex;align-items:center;justify-content:center;font-size:28px;cursor:pointer;user-select:none"
            onclick="window.app.openNativeEmojiPicker()"
            title="Нажмите чтобы выбрать эмодзи устройства">${escHtml(current)}</div>
          <button class="btn" style="font-size:10px;padding:3px 8px;gap:3px" onclick="window.app.openNativeEmojiPicker()">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="width:10px;height:10px"><circle cx="7" cy="7" r="5.5"/><path d="M4.5 8.5s.8 1.5 2.5 1.5 2.5-1.5 2.5-1.5M5 5.5h.01M9 5.5h.01"/></svg>
            Выбрать
          </button>
          <!-- Скрытый input для нативного picker -->
          <input id="rb-emoji-inp" type="text" inputmode="text" maxlength="6"
            style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px"
            value="${escHtml(current)}"
            oninput="window.app.onEmojiInputChange(this)">
        </div>
        <!-- Название -->
        <div style="flex:1">
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;font-weight:600">Название группы</div>
          <input class="form-input" id="rename-inp" value="${escHtml(currentName)}" placeholder="Кровати, Комоды…">
          <div style="font-size:10px;color:var(--muted);margin-top:6px">
            Для выбора эмодзи нажмите кнопку слева или используйте <b>${shortcut}</b>
          </div>
        </div>
      </div>
      <span id="sticker-display" style="display:none">${escHtml(current)}</span>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.doRenameBox('${id}')">Сохранить</button>`
    );
    setTimeout(() => {
      const inp = document.getElementById('rename-inp') as HTMLInputElement;
      if (inp) { inp.focus(); inp.select(); }
    }, 50);
  }

  /** Открыть нативный эмодзи-пикер устройства */
  openNativeEmojiPicker() {
    const inp = document.getElementById('rb-emoji-inp') as HTMLInputElement;
    if (!inp) return;
    // Делаем input видимым и фокусируемым, затем скрываем обратно
    inp.style.cssText = 'position:fixed;bottom:50%;left:50%;width:40px;height:40px;opacity:.01;font-size:24px;border:none;outline:none;z-index:9999';
    inp.focus();
    // На большинстве устройств это не триггерит picker, поэтому используем clipboard trick
    // Лучший кросс-браузерный способ — просто сфокусировать и сказать пользователю нажать шортат
    setTimeout(() => {
      inp.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px';
    }, 3000);
  }

  onEmojiInputChange(inp: HTMLInputElement) {
    const emoji = extractFirstEmoji(inp.value.trim());
    if (emoji) {
      inp.value = emoji;
      this.selectSticker(emoji, true);
      // Обновляем отображение
      const display = document.getElementById('rb-emoji-display');
      if (display) display.textContent = emoji;
    }
    else if (inp.value.trim() === '') {
      inp.value = '📦'; this.selectSticker('📦', true);
      const display = document.getElementById('rb-emoji-display');
      if (display) display.textContent = '📦';
    }
  }

  selectSticker(emoji: string, _keepOpen?: boolean) {
    const display = document.getElementById('sticker-display');
    if (display) display.textContent = emoji;
    const emojiInp = document.getElementById('rb-emoji-inp') as HTMLInputElement;
    if (emojiInp && emojiInp.value !== emoji) emojiInp.value = emoji;
    document.querySelectorAll('.rb-quick-btn').forEach(b => {
      (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.emoji === emoji);
    });
  }

  async doRenameBox(id: string) {
    const inp = document.getElementById('rename-inp') as HTMLInputElement;
    if (!inp) return;
    const name = inp.value.trim();
    if (!name) { this.app.toast('Введите название', 'error'); return; }
    const sticker = document.getElementById('sticker-display')?.textContent?.trim() || '📦';
    try {
      await apiService.updateBox(id, { name, sticker });
      boxActions.updateBox(id, { name, sticker });
      this.app.renderBoxes();
      this.app.closeModal();
      this.app.toast('Название и стикер обновлены', 'success');
    } catch (e: any) { this.app.toast('Ошибка: ' + e.message, 'error'); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOX MODALS — SETTINGS (единая панель настроек группы)
  // ─────────────────────────────────────────────────────────────────────────

  /** legacy, unused */
  private _bsActiveTabLegacy: string = 'main'; private get _bsActiveTab() { return this._bsActiveTabLegacy; } private set _bsActiveTab(v: string) { this._bsActiveTabLegacy = v; }

  openBoxSettings(id: string, _tab?: string) {
    const box = boxes.get().find(b => b.id === id);
    if (!box) return;

    // API-синхронизированная группа — упрощённый просмотр
    if (box.mp_source) {
      const mpLabel = box.mp_source === 'ozon' ? '🟠 Ozon' : box.mp_source === 'ym' ? '🟡 Яндекс Маркет' : '🟣 WB';
      const lastSync = box.mp_last_sync
        ? new Date(box.mp_last_sync).toLocaleString('ru', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
        : 'ещё не синхронизировано';
      this.app.openModal(
        'Магазин', box.name,
        `<div style="display:flex;flex-direction:column;gap:10px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div style="padding:10px 12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
              <div style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">Источник</div>
              <div style="font-size:13px;font-weight:600">${mpLabel}</div>
            </div>
            <div style="padding:10px 12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
              <div style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">Последнее обновление</div>
              <div style="font-size:12px;font-weight:600">${lastSync}</div>
            </div>
          </div>
          <div style="padding:10px 12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">ID магазина</div>
            <div style="font-size:11px;font-family:monospace;color:var(--text2)">${escHtml(box.mp_store_id || '—')}</div>
          </div>
          <div style="font-size:11px;color:var(--muted);line-height:1.5;padding:8px 0">
            Эта группа управляется автоматически через API маркетплейса. Для обновления данных нажмите «↻ Обновить».
          </div>
        </div>`,
        `<button class="btn btn-danger" onclick="window.app.deleteBox('${id}','${escHtml(box.name)}')">Удалить</button>
         <button class="btn" onclick="window.app.closeModal()">Закрыть</button>
         <button class="btn btn-primary" onclick="window.app.closeModal();window.app.refreshMpBox('${id}')">↻ Обновить</button>`
      );
      return;
    }

    // Ручная группа — компактные настройки
    const quick = ['📦','🎁','🛒','🛍️','📁','🗂️','📋','💼','🏠','🚚','🌟','💎','🔥','🎯','🎨','📱','💻','🎮','⚽','🍔'];
    const current = box.sticker || '📦';
    this.app.openModal(
      'Настройки группы', '',
      `<div style="display:flex;flex-direction:column;gap:12px">
        <div class="rb-row">
          <div class="rb-emoji-wrap">
            <input class="rb-emoji-input" id="bs-emoji-inp" maxlength="6" value="${escHtml(current)}"
              oninput="window.app.onEmojiInputChange(this)" inputmode="text">
            <span class="rb-emoji-tag">Тап</span>
          </div>
          <div class="rb-name-wrap">
            <div class="rb-name-label">Название</div>
            <input class="rb-name-inp" id="rename-inp" value="${escHtml(box.name)}" placeholder="Название группы">
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${quick.map(e => `<button class="rb-quick-btn ${current === e ? 'active' : ''}" onclick="window.app.selectSticker('${e}')">${e}</button>`).join('')}
        </div>
      </div>`,
      `<button class="btn btn-danger" style="margin-right:auto" onclick="window.app.deleteBox('${id}','${escHtml(box.name)}')">Удалить</button>
       <button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.doRenameBox('${id}')">Сохранить</button>`
    );
    setTimeout(() => {
      const inp = document.getElementById('rename-inp') as HTMLInputElement;
      if (inp) { inp.focus(); inp.select(); }
    }, 50);
  }

  /** Переключение вкладок в модале настроек */
  bsSwitchTab(boxId: string, tab: 'main' | 'marketplaces' | 'columns' | 'products' | 'data'): void {
    this._bsActiveTab = tab;
    this.openBoxSettings(boxId);
  }

  /** Фильтр товаров по поиску на вкладке «Товары» */
  filterBsProducts(query: string): void {
    const q = query.toLowerCase().trim();
    document.querySelectorAll<HTMLElement>('#bs-products-list > div').forEach(row => {
      const txt = row.textContent?.toLowerCase() || '';
      row.style.display = !q || txt.includes(q) ? '' : 'none';
    });
  }

  /** Сбросить пользовательский порядок столбцов */
  resetColumnOrder(boxId: string): void {
    this.app.columnOrder.delete(boxId);
    try {
      const co: Record<string, string[]> = {};
      for (const [bid, cls] of this.app.columnOrder) co[bid] = cls;
      localStorage.setItem('app_column_order', JSON.stringify(co));
    } catch {}
    this.app.toast('Порядок столбцов сброшен', 'success');
    this.app.buildColumns();
    this.openBoxSettings(boxId);
  }

  /** @deprecated */
  bsSelectSticker(emoji: string) {
    const display = document.getElementById('bs-sticker-display');
    if (display) display.textContent = emoji;
    const inp = document.getElementById('bs-emoji-inp') as HTMLInputElement;
    if (inp && inp.value !== emoji) inp.value = emoji;
    document.querySelectorAll('#bs-quick .rb-quick-btn').forEach(b => {
      (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.emoji === emoji);
    });
  }

  // Сохранить настройки группы (название + стикер + столбцы)
  async saveBoxSettings(id: string) {
    const nameInp = document.getElementById('bs-name-inp') as HTMLInputElement;
    const name = nameInp?.value?.trim();
    if (!name) { this.app.toast('Введите название', 'error'); return; }
    const sticker = document.getElementById('bs-sticker-display')?.textContent?.trim() || '📦';

    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Сохраняю…'; }

    try {
      const prefStoreInp = document.getElementById('bs-pref-store') as HTMLSelectElement;
      const ozon_preferred_store_id = prefStoreInp?.value || null;
      let showedWarning = false;

      try {
        await apiService.updateBox(id, { name, sticker, ozon_preferred_store_id });
        boxActions.updateBox(id, { name, sticker, ozon_preferred_store_id });
      } catch (err: any) {
        // Если ошибка 400 (вероятно, не добавлена колонка в БД), пробуем обновить без нее
        if (err.message?.includes('400') || err.message?.includes('column "ozon_preferred_store_id" does not exist')) {
           console.warn('Column ozon_preferred_store_id missing in DB, skipping field update');
           await apiService.updateBox(id, { name, sticker });
           boxActions.updateBox(id, { name, sticker });
           this.app.toast('Настройки сохранены (без выбора магазина — нужно добавить колонку в БД)', 'warning');
           showedWarning = true;
        } else {
           throw err;
        }
      }

      // Применяем настройки столбцов
      this.app.applyColPicker();
      this.app.renderBoxes();
      this.app.closeModal();
      if (!showedWarning) {
        this.app.toast('Настройки сохранены', 'success');
      }
    } catch (e: any) {
      this.app.toast('Ошибка: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
    }
  }

  // Связать группу со всеми магазинами Ozon
  async linkBoxToOzon(boxId: string) {
    const skuField = (document.getElementById('bs-sku-field') as HTMLSelectElement)?.value || 'Артикул*';
    const btn = document.querySelector<HTMLButtonElement>('#modal-body .btn-primary, #sh-ozon-link-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Связываю…'; }
    try {
      const prefStoreId = (document.getElementById('bs-pref-store') as HTMLSelectElement)?.value || null;
      await apiService.linkBoxToOzon(boxId, 'all', skuField, prefStoreId);
      boxActions.updateBox(boxId, { ozon_store_id: 'all', ozon_sku_field: skuField, ozon_preferred_store_id: prefStoreId });
      this.app.toast('Группа привязана ко всем магазинам Ozon ✓', 'success');
      this.app.closeModal();
      this.app.renderBoxes();
      (window as any).settingsHub?.init?.();
      setTimeout(() => this.app.syncLinkedBox(boxId), 300);
    } catch (e: any) {
      this.app.toast('Ошибка: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Связать'; }
    }
  }

  // Отвязать группу от Ozon
  async unlinkBoxFromOzon(boxId: string) {
    try {
      await apiService.linkBoxToOzon(boxId, null);
      boxActions.updateBox(boxId, { ozon_store_id: null, ozon_sku_field: null });
      this.app.toast('Группа отвязана от Ozon', 'success');
      this.app.closeModal();
      this.app.renderBoxes();
      (window as any).settingsHub?.init?.();
    } catch (e: any) {
      this.app.toast('Ошибка: ' + e.message, 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOX MODALS — EDIT (columns + products)
  // ─────────────────────────────────────────────────────────────────────────

  /** Legacy alias: старый editBox теперь открывает единое окно настроек */
  editBox(id: string) { this.openBoxSettings(id); }

  deleteBoxRow(boxId: string, col: string) {
    this.app.pendingDelete = { boxId, col };
    this.app.openModal('Удалить столбец?', `«${escHtml(col.replace('*', ''))}»`,
      `<p style="font-size:13px;color:var(--text2);line-height:1.6">Столбец будет удалён у всех товаров.<br>Это нельзя отменить.</p>`,
      `<button class="btn" onclick="window.app.openBoxSettings('${boxId}')">Отмена</button>
       <button class="btn btn-danger" onclick="window.app.doDeleteBoxRow()">Удалить</button>`
    );
  }

  async doDeleteBoxRow() {
    const { boxId, col } = this.app.pendingDelete || {};
    if (!boxId || !col) return;
    this.app.pendingDelete = null;
    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-danger');
    if (btn) { btn.disabled = true; btn.textContent = 'Удаляю...'; }
    try {
      const prods = await apiService.getProductsByBox(boxId);
      for (const p of (prods || [])) {
        const data = p.data || {};
        if (data[col] !== undefined) {
          delete data[col];
          await apiService.updateProduct(p.id, { data });
        }
      }
      this.app.toast('Столбец удалён', 'success');
      this.app.closeModal();
      if (this.app.activeBoxId === boxId) {
        await this.app.loadBoxProducts();
        const order = this.app.columnOrder.get(boxId);
        if (order) {
          this.app.columnOrder.set(boxId, order.filter(c => c !== col));
          const co: Record<string, string[]> = {};
          for (const [bid, cl] of this.app.columnOrder) co[bid] = cl;
          localStorage.setItem('app_column_order', JSON.stringify(co));
        }
        this.openBoxSettings(boxId);
      }
    } catch (e: any) { this.app.toast('Ошибка: ' + e.message, 'error'); }
  }

  deleteProductFromBox(boxId: string, prodId: string, art: string) {
    this.app.pendingDelete = { boxId, prodId, art };
    this.app.openModal('Удалить товар?', `Артикул: ${escHtml(art)}`,
      `<p style="font-size:13px;color:var(--text2)">Это действие нельзя отменить.</p>`,
      `<button class="btn" onclick="window.app.openBoxSettings('${boxId}')">Отмена</button>
       <button class="btn btn-danger" onclick="window.app.doDeleteProductFromBox()">Удалить</button>`
    );
  }

  async doDeleteProductFromBox() {
    const { boxId, prodId } = this.app.pendingDelete || {};
    if (!boxId || !prodId) return;
    this.app.pendingDelete = null;
    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-danger');
    if (btn) { btn.disabled = true; btn.textContent = 'Удаляю...'; }
    try {
      await apiService.deleteProduct(prodId);
      this.app.cache.delete(boxId);
      idbCache.remove(boxId).catch(() => {});
      this.app.toast('Товар удалён', 'success');
      this.app.closeModal();
      if (this.app.activeBoxId === boxId) await this.app.loadBoxProducts();
      this.app.loadBoxCount(boxId);
      // Открываем настройки заново, чтобы пользователь видел обновлённый список
      this.openBoxSettings(boxId);
    } catch (e: any) { this.app.toast('Ошибка: ' + e.message, 'error'); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOX MODALS — DELETE
  // ─────────────────────────────────────────────────────────────────────────

  deleteBox(id: string, name: string) {
    this.app.openModal('Удалить группу?', `«${name}»`,
      `<div style="background:var(--red-dim);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:14px 16px;margin-bottom:4px">
        <div style="font-size:13px;color:var(--red);font-weight:500;margin-bottom:6px">⚠ Внимание — это нельзя отменить</div>
        <div style="font-size:12.5px;color:var(--text2);line-height:1.6">Будут удалены все товары и листы внутри группы «${escHtml(name)}».</div>
      </div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-danger" onclick="window.app.doDeleteBox('${id}')">Удалить группу</button>`
    );
  }

  async doDeleteBox(id: string) {
    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-danger');
    if (btn) { btn.disabled = true; btn.textContent = 'Удаляю...'; }
    try {
      await apiService.deleteProductsByBox(id);
      const sheets = await apiService.getSheetsByBox(id);
      for (const s of (sheets || [])) await apiService.deleteSheet(s.id);
      await apiService.deleteBox(id);
      this.app.cache.delete(id);
      idbCache.remove(id).catch(() => {});
      boxActions.removeBox(id);
      if (this.app.activeBoxId === id) {
        this.app.activeBoxId = null;
        localStorage.removeItem('last_box_id');
        this.app.selectedProducts.clear();
        this.app.renderActionBar();
        this.app.renderProducts();
        this.app.allProducts = [];
        this.app.filtered = [];
        const addBtn = document.getElementById('add-product-btn');
        if (addBtn) addBtn.style.display = 'none';
        this.app.navigateTo('home');
      }
      this.app.renderBoxes();
      this.app.closeModal();
      this.app.toast('Группа удалена', 'success');
    } catch (e: any) { this.app.toast('Ошибка: ' + e.message, 'error'); }
  }
}
