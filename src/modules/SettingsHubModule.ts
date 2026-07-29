/**
 * SettingsHubModule — центр настроек со страницами:
 *   1. Кастомные колонки (себестоимость + дополнительные поля)
 *   2. Формулы цен (per-store)
 *   3. Импорт / Экспорт значений товаров (XLSX)
 *
 * Вместо одностраничной формы — навигация между группами.
 */

import * as XLSX from 'xlsx';
import { customColumnsDb, CustomColumn } from '@/services/customColumnsDb';
import { priceFormulasDb, evaluateFormula, validateFormula } from '@/services/priceFormulas';
import { ozonDb } from '@/services/ozonDb';
import { yandexDb } from '@/services/yandexDb';
import { wbDb } from '@/services/wbDb';
import { companyService, CompanyRole } from '@/services/companyService';
import { OzonStore } from '@/types/ozon';
import { YandexStore } from '@/types/yandex';
import { WbStore } from '@/types/wb';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';

type Page = 'group' | 'columns' | 'formulas' | 'import-export' | 'team' | 'appearance';
type AnyStore = (OzonStore & { _mp: 'ozon' }) | (YandexStore & { _mp: 'yandex' }) | (WbStore & { _mp: 'wb' });

interface ImportPreview {
  total: number;
  willInsert: number;
  willUpdate: Array<{ offer_id: string; column: string; oldValue: any; newValue: any }>;
  unknown: number;
}

export class SettingsHubModule {
  private container: HTMLElement;
  private page: Page = 'group';
  private columns: CustomColumn[] = [];
  private stores: AnyStore[] = [];
  private importPreview: ImportPreview | null = null;
  private importUpdates: Array<{ offer_id: string; column_id: string; value: any }> = [];
  private teamMembers: Array<{ id: string; user_id: string; role: CompanyRole; joined_at: string; first_name: string; telegram_username: string | null; photo_url: string | null; joined_via_link_id: string | null }> = [];
  private pendingInvites: Array<{ id: string; telegram_username: string; role: CompanyRole; created_at: string }> = [];
  private inviteLinks: Array<{ id: string; token: string; role: CompanyRole; use_count: number; is_active: boolean }> = [];

  constructor(container: HTMLElement) { this.container = container; }

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.init();
  }
  hide(): void { this.container.style.display = 'none'; }

  private getCurrentBoxId(): string | null {
    return window.app?.activeBoxId ?? null;
  }

  async init(): Promise<void> {
    const boxId = this.getCurrentBoxId();
    this.columns = customColumnsDb.getColumns(boxId);
    const [oz, ym, wb] = await Promise.all([
      ozonDb.getStores().catch(() => [] as OzonStore[]),
      yandexDb.getStores().catch(() => [] as YandexStore[]),
      wbDb.getStores().catch(() => [] as WbStore[]),
    ]);
    this.stores = [
      ...oz.map(s => ({ ...s, _mp: 'ozon' as const })),
      ...ym.map(s => ({ ...s, _mp: 'yandex' as const })),
      ...wb.map(s => ({ ...s, _mp: 'wb' as const })),
    ];
    this.render();
  }

  setPage(p: Page): void {
    this.page = p;
    if (p === 'team') {
      this.render();
      this.loadTeamData();
    } else {
      this.render();
    }
  }

  // ─────────────────────────────────────────────────────────────
  //   PAGE: Параметры группы (полностью inline, без модалки)
  // ─────────────────────────────────────────────────────────────

  private renderGroupPage(): string {
    const w: any = window;
    const boxId = this.getCurrentBoxId();
    const box = w.app?.getActiveBox?.() as { id: string; name: string; sticker?: string; ozon_store_id?: string | null; ozon_sku_field?: string | null; ozon_preferred_store_id?: string | null; ym_linked?: boolean; ym_sku_field?: string | null; wb_linked?: boolean; wb_sku_field?: string | null } | null;
    const groupName = box?.name ?? w.app?.getActiveGroupName?.() as string | null;
    const offersCount = this.getGroupOffers().length;

    if (!boxId || !box) {
      return `
        <div class="sh-page">
          <div class="sh-page-head">
            <div class="sh-page-title">Параметры группы</div>
          </div>
          <div class="sh-card" style="border-color:#f59e0b;background:color-mix(in srgb,#fbbf24 6%,var(--bg))">
            <div style="display:flex;align-items:center;gap:14px">
              <span style="font-size:28px">${I.package('', 28)}</span>
              <div style="flex:1">
                <div style="font-size:14px;font-weight:700;margin-bottom:4px">Группа не выбрана</div>
                <div style="font-size:12px;color:var(--muted)">Выбери группу в разделе «Товары», затем вернись сюда</div>
              </div>
              <button class="btn btn-primary" onclick="window.app.navigateTo('products', {loadAll:true})">К Товарам →</button>
            </div>
          </div>
        </div>
      `;
    }

    // ── Данные маркетплейсов ──
    const ozonStores: Array<{ id: string; name: string }> = w.ozonModule?.stores || [];
    const ymStores:   Array<{ id: string; name: string }> = w.yandexModule?.stores || [];
    const wbStores:   Array<{ id: string; name: string }> = w.wbModule?.stores || [];
    const isOzonLinked = !!box.ozon_store_id;
    const isYmLinked   = !!box.ym_linked;
    const isWbLinked   = !!box.wb_linked;
    const cols: string[] = w.app?.columns ?? [];
    const skuOptions = ['Артикул*', ...cols.filter((c: string) => c !== 'Артикул*' && !c.startsWith('★') && !c.startsWith('_'))];

    const quick = ['📦','🎁','🛒','🛍️','📁','🗂️','📋','💼','🏠','🚚','🌟','💎','🔥','🎯','🎨','📱','💻','🎮','⚽','🍔'];
    const current = box.sticker || '📦';

    // ── Карточка маркетплейса ──
    const mpCard = (
      mp: 'ozon' | 'ym' | 'wb',
      label: string,
      color: string,
      stores: Array<{ id: string; name: string }>,
      isLinked: boolean,
      skuField: string | null | undefined,
      _prefStoreId?: string | null,
    ) => {
      const skuSelectId = mp === 'ozon' ? 'bs-sku-field' : mp === 'ym' ? 'bs-ym-sku-field' : 'bs-wb-sku-field';
      const prefSelectId = mp === 'ozon' ? 'bs-pref-store' : null;
      const linkFn   = `window.app.linkBoxTo${mp === 'ozon' ? 'Ozon' : mp === 'ym' ? 'YM' : 'WB'}('${boxId}')`;
      const unlinkFn = `window.app.unlinkBoxFrom${mp === 'ozon' ? 'Ozon' : mp === 'ym' ? 'YM' : 'WB'}('${boxId}')`;
      const syncFn   = `window.app.syncLinkedBox${mp === 'ozon' ? '' : mp === 'ym' ? 'YM' : 'WB'}('${boxId}')`;

      if (isLinked) {
        return `
          <div class="sh-mp-card sh-mp-linked" style="--mp-color:${color}">
            <div class="sh-mp-card-head">
              <span class="sh-mp-dot" style="background:${color}"></span>
              <span class="sh-mp-name">${label}</span>
              <span class="sh-mp-status linked">● Привязана</span>
            </div>
            <div class="sh-mp-info">
              ${stores.length > 0 ? `<span style="font-size:11px;color:var(--muted)">${stores.map(s => this.esc(s.name)).join(', ')}</span>` : ''}
              <span style="font-size:11px;color:var(--muted)">Артикул: <b style="color:var(--text)">${this.esc(skuField || 'Артикул*')}</b></span>
            </div>
            <div class="sh-mp-actions">
              <button class="btn btn-primary" style="font-size:11px;padding:5px 12px" onclick="${syncFn}">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:11px;height:11px"><path d="M13 7A6 6 0 1 1 7.5 1.1M13 1v4H9"/></svg>
                Синхр. сейчас
              </button>
              <button class="btn" style="font-size:11px;padding:5px 12px;color:var(--red);border-color:var(--red-dim)" onclick="${unlinkFn}">Отвязать</button>
            </div>
          </div>`;
      }

      if (stores.length === 0) {
        return `
          <div class="sh-mp-card" style="--mp-color:${color}">
            <div class="sh-mp-card-head">
              <span class="sh-mp-dot" style="background:${color};opacity:.35"></span>
              <span class="sh-mp-name">${label}</span>
              <span class="sh-mp-status">○ Не привязана</span>
            </div>
            <div style="font-size:11px;color:var(--muted);padding:2px 0">Нет магазинов. Добавь в разделе «Маркетплейсы».</div>
          </div>`;
      }

      return `
        <div class="sh-mp-card" style="--mp-color:${color}">
          <div class="sh-mp-card-head">
            <span class="sh-mp-dot" style="background:${color};opacity:.35"></span>
            <span class="sh-mp-name">${label}</span>
            <span class="sh-mp-status">○ Не привязана</span>
          </div>
          <div class="sh-mp-form">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <label style="font-size:11px;color:var(--muted);white-space:nowrap">Поле артикула:</label>
              <select id="${skuSelectId}" class="oz-filter-sel" style="font-size:11px;flex:1;min-width:120px">
                ${skuOptions.map(c => `<option value="${this.esc(c)}">${this.esc(c.replace('*',''))}</option>`).join('')}
              </select>
              ${prefSelectId ? `
                <label style="font-size:11px;color:var(--muted);white-space:nowrap">Приоритет:</label>
                <select id="${prefSelectId}" class="oz-filter-sel" style="font-size:11px;flex:1;min-width:120px">
                  <option value="">Любой</option>
                  ${stores.map(s => `<option value="${s.id}">${this.esc(s.name)}</option>`).join('')}
                </select>
              ` : ''}
            </div>
          </div>
          <div class="sh-mp-actions">
            <button id="sh-${mp}-link-btn" class="btn btn-primary" style="font-size:11px;padding:5px 14px" onclick="${linkFn}">
              Связать с ${label}
            </button>
          </div>
        </div>`;
    };

    return `
      <div class="sh-page">
        <div class="sh-page-head">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:28px">${this.esc(current)}</span>
            <div>
              <div class="sh-page-title">${this.esc(groupName ?? '—')}</div>
              <div style="font-size:11px;color:var(--muted)">${offersCount} товаров</div>
            </div>
          </div>
        </div>

        <!-- ── Название и значок ── -->
        <div class="sh-card">
          <div class="sh-card-title">Название и значок</div>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
            <input id="sh-group-emoji" class="ym-input" maxlength="6" value="${this.esc(current)}"
              style="width:52px;text-align:center;font-size:20px;padding:6px">
            <input id="sh-group-name" class="ym-input" value="${this.esc(box.name)}"
              placeholder="Название группы" style="flex:1"
              onkeydown="if(event.key==='Enter')window.app.saveBoxNameFromHub('${boxId}')">
            <button class="btn btn-primary" style="white-space:nowrap" onclick="window.app.saveBoxNameFromHub('${boxId}')">
              Сохранить
            </button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:5px">
            ${quick.map(s => `<button
              style="font-size:18px;padding:4px 7px;border-radius:6px;border:1px solid ${s === current ? 'var(--accent)' : 'var(--border)'};background:${s === current ? 'color-mix(in srgb,var(--accent) 10%,transparent)' : 'var(--bg3)'};cursor:pointer;transition:all .15s"
              onclick="document.getElementById('sh-group-emoji').value='${s}'">${s}</button>`).join('')}
          </div>
        </div>

        <!-- ── Синхронизация ── -->
        <div class="sh-card">
          <div class="sh-card-title">Синхронизация с маркетплейсами</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${mpCard('ozon', 'Ozon', '#005bff', ozonStores, isOzonLinked, box.ozon_sku_field, box.ozon_preferred_store_id)}
            ${mpCard('ym',   'Яндекс Маркет', '#fc3f1d', ymStores, isYmLinked, box.ym_sku_field)}
            ${mpCard('wb',   'Wildberries',   '#cb11ab', wbStores, isWbLinked, box.wb_sku_field)}
          </div>
        </div>

        <!-- ── Управление группой ── -->
        <div class="sh-card">
          <div class="sh-card-title">Управление группой</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" style="font-size:12px" onclick="window.app.openImportModal()">
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M7 1v8M3 5l4 4 4-4M1 11v2h12v-2"/></svg>
              Импортировать XLSX
            </button>
            <button class="btn btn-danger" style="font-size:12px;margin-left:auto"
              onclick="window.app.deleteBox('${boxId}','${this.esc(box.name)}')">
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:11px;height:11px"><path d="M2 4h10M5 4V2h4v2M4 4l1 9h4l1-9"/></svg>
              Удалить группу
            </button>
          </div>
        </div>
      </div>
    `;
  }

  render(): void {
    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>
              </svg>
              <span class="oz-brand-name">Настройки</span>
            </div>
          </div>
        </div>

        <div class="sh-layout">
          <!-- Боковое меню настроек -->
          <aside class="sh-sidebar">
            <button class="sh-side-item ${this.page === 'group' ? 'active' : ''}" onclick="window.settingsHub.setPage('group')">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v1M8 14v1M1 8h1M14 8h1M3.2 3.2l.7.7M12.1 12.1l.7.7M12.1 3.9l-.7.7M3.9 12.1l-.7.7"/><circle cx="8" cy="8" r="5.5"/></svg>
              Параметры группы
            </button>

            <div class="sh-side-section">Данные товаров</div>
            <button class="sh-side-item ${this.page === 'columns' ? 'active' : ''}" onclick="window.settingsHub.setPage('columns')">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
              Колонки и себестоимость
            </button>
            <button class="sh-side-item ${this.page === 'import-export' ? 'active' : ''}" onclick="window.settingsHub.setPage('import-export')">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v8M5 7l3 3 3-3M2 13h12"/></svg>
              Импорт / Экспорт
            </button>

            <div class="sh-side-section">Ценообразование</div>
            <button class="sh-side-item ${this.page === 'formulas' ? 'active' : ''}" onclick="window.settingsHub.setPage('formulas')">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4h2M3 8h4M3 12h2M9 4h4M9 8l4 4M9 12l4-4"/></svg>
              Формулы цен
            </button>

            <div class="sh-side-section">Компания</div>
            <button class="sh-side-item ${this.page === 'team' ? 'active' : ''}" onclick="window.settingsHub.setPage('team')">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="5" r="2"/><circle cx="10.5" cy="5" r="2"/><path d="M1 14c0-2.5 2-4 4.5-4M9 14c0-2.5 2-4 4.5-4M8 14c0-2 1.3-3 2.5-3"/></svg>
              Команда
            </button>

            <div class="sh-side-section">Интерфейс</div>
            <button class="sh-side-item ${this.page === 'appearance' ? 'active' : ''}" onclick="window.settingsHub.setPage('appearance')">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 2v6l3 3"/></svg>
              Внешний вид
            </button>
          </aside>

          <main class="sh-main">
            ${this.page === 'group'         ? this.renderGroupPage() : ''}
            ${this.page === 'columns'       ? this.renderColumns() : ''}
            ${this.page === 'formulas'      ? this.renderFormulas() : ''}
            ${this.page === 'import-export' ? this.renderImportExport() : ''}
            ${this.page === 'team'          ? this.renderTeamPage() : ''}
            ${this.page === 'appearance'    ? this.renderAppearancePage() : ''}
          </main>
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────────────────────
  //   PAGE: Колонки
  // ─────────────────────────────────────────────────────────────

  private renderColumns(): string {
    const w: any = window;
    const groupName = w.app?.getActiveGroupName?.() as string | null;
    const boxId = this.getCurrentBoxId();
    return `
      <div class="sh-page">
        <div class="sh-page-head">
          <div class="sh-page-title">Колонки товаров</div>
          <div class="sh-page-sub">
            ${groupName
              ? `<span class="sh-context-tag">${I.package('', 14)} Группа: ${this.esc(groupName)}</span>`
              : `<span class="sh-context-tag" style="background:color-mix(in srgb,#94a3b8 16%,transparent);color:#64748b">${I.alertTriangle('', 14)} Группа не выбрана</span>`}
            <br>Добавляй индивидуальные поля для текущей группы: артикул производителя, размеры, материалы и т.п.
            <b>Себестоимость</b> — общая системная колонка для всех групп.
            Пользовательские колонки <b>привязаны только к выбранной группе</b>.
          </div>
        </div>${boxId ? '' : `
        <div class="sh-card" style="border-color:#f59e0b;background:color-mix(in srgb,#fbbf24 8%,var(--bg))">
          <div style="display:flex;align-items:center;gap:10px;font-size:13px">
            <span style="font-size:18px">${I.alertTriangle('', 18)}</span>
            <span>Открой группу в разделе «Товары», чтобы добавлять кастомные колонки именно для неё.</span>
          </div>
        </div>`}

        <!-- Форма добавления колонки -->
        <div class="sh-card">
          <div class="sh-card-title">Добавить колонку</div>
          <div class="sh-row">
            <input id="col-label" class="ym-input" placeholder="Название (например: Артикул производителя)" autocomplete="off">
            <select id="col-type" class="oz-filter-sel">
              <option value="text">Текст</option>
              <option value="number">Число</option>
            </select>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);user-select:none;cursor:pointer">
              <input type="checkbox" id="col-show" style="accent-color:#005bff"> Показывать в таблице
            </label>
            <button class="btn btn-primary" onclick="window.settingsHub.addColumn()">Создать</button>
          </div>
        </div>

        <!-- Существующие колонки — drag-and-drop -->
        <div class="sh-card">
          <div style="padding:8px 14px;font-size:11px;color:var(--muted);background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M5 3v8M9 3v8M3 5h8M3 9h8"/></svg>
            <span>Перетащи колонку за <b>⠿</b>, чтобы изменить порядок отображения в таблице товаров</span>
          </div>
          <div class="sh-cols-list" id="sh-cols-list">
            ${this.columns.map(c => this.renderColRow(c)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  /** Одна строка колонки (drag-and-drop). */
  private renderColRow(c: CustomColumn): string {
    const vals = customColumnsDb.getAllValues();
    const filled = Object.values(vals).filter(v => v[c.id] != null && v[c.id] !== '').length;
    return `
      <div class="sh-col-row" draggable="${!c.system}" data-col-id="${this.esc(c.id)}"
        ondragstart="window.settingsHub.onColDragStart(event,'${this.esc(c.id)}')"
        ondragover="event.preventDefault();this.classList.add('drag-over')"
        ondragleave="this.classList.remove('drag-over')"
        ondrop="event.preventDefault();this.classList.remove('drag-over');window.settingsHub.onColDrop(event,'${this.esc(c.id)}')">
        <div class="sh-col-drag" title="${c.system ? 'Системная — нельзя двигать' : 'Перетащи'}">${c.system ? I.lock('', 14) : '⠿'}</div>
        <div class="sh-col-info">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-weight:700;font-size:13px">${this.esc(c.label)}</span>
            ${c.system ? '<span class="oz-badge ord-s-ready" style="font-size:9px">системная</span>' : ''}
            <span style="font-size:10px;color:var(--muted);font-family:monospace">${this.esc(c.id.slice(0, 8))}…</span>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px">
            ${c.data_type === 'number' ? `${I.hash('', 14)} Число` : '🅰️ Текст'} · Заполнено: <b>${filled}</b>
            ${c.description ? ` · ${this.esc(c.description)}` : ''}
          </div>
        </div>
        <label class="sh-col-toggle" title="Показывать в таблице товаров">
          <input type="checkbox" ${c.show_in_table ? 'checked' : ''} onchange="window.settingsHub.toggleShow('${this.esc(c.id)}', this.checked)" style="accent-color:#005bff">
          <span>В таблице</span>
        </label>
        ${c.system ? '<span style="width:24px"></span>' : `
          <button class="oz-tab-btn" onclick="window.settingsHub.deleteColumn('${this.esc(c.id)}')" title="Удалить">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 4h10M5 4V2h4v2M4 4l1 9h4l1-9"/></svg>
          </button>
        `}
      </div>
    `;
  }

  private draggedColId: string | null = null;

  onColDragStart(e: DragEvent, id: string): void {
    this.draggedColId = id;
    e.dataTransfer?.setData('text/plain', id);
  }

  onColDrop(_e: DragEvent, targetId: string): void {
    if (!this.draggedColId || this.draggedColId === targetId) return;
    const userCols = this.columns.filter(c => !c.system);
    const ids = userCols.map(c => c.id);
    const fromIdx = ids.indexOf(this.draggedColId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, moved);
    customColumnsDb.reorderColumns(ids);
    this.draggedColId = null;
    this.columns = customColumnsDb.getColumns(this.getCurrentBoxId());
    this.render();
  }

  addColumn(): void {
    const boxId = this.getCurrentBoxId();
    if (!boxId) {
      alert('Выбери группу в разделе «Товары» — кастомные колонки привязаны к группе.');
      return;
    }
    const lbl = (document.getElementById('col-label') as HTMLInputElement)?.value.trim();
    const type = (document.getElementById('col-type') as HTMLSelectElement)?.value as 'text' | 'number';
    const show = (document.getElementById('col-show') as HTMLInputElement)?.checked;
    if (!lbl) { alert('Укажи название колонки'); return; }
    customColumnsDb.addColumn({ label: lbl, data_type: type, show_in_table: show, box_id: boxId });
    this.columns = customColumnsDb.getColumns(boxId);
    this.render();
    // Notify the products table to rebuild columns so the new one appears immediately
    window.app?.buildColumnsAndRefresh?.();
  }

  toggleShow(id: string, checked: boolean): void {
    customColumnsDb.updateColumn(id, { show_in_table: checked });
    this.columns = customColumnsDb.getColumns(this.getCurrentBoxId());
    this.render();
    window.app?.buildColumnsAndRefresh?.();
  }

  deleteColumn(id: string): void {
    const col = this.columns.find(c => c.id === id);
    if (!col || col.system) return;
    if (!confirm(`Удалить колонку «${col.label}»? Все её значения будут потеряны.`)) return;
    customColumnsDb.deleteColumn(id);
    this.columns = customColumnsDb.getColumns(this.getCurrentBoxId());
    this.render();
    window.app?.buildColumnsAndRefresh?.();
  }

  // ─────────────────────────────────────────────────────────────
  //   PAGE: Формулы цен
  // ─────────────────────────────────────────────────────────────

  private renderFormulas(): string {
    if (this.stores.length === 0) {
      return `<div class="sh-page">
        <div class="oz-empty"><div class="oz-empty-title">Нет магазинов</div><div class="oz-empty-sub">Подключи магазины в разделе «Маркетплейсы»</div></div>
      </div>`;
    }

    const formulas = priceFormulasDb.getAll();
    const testCost = 1000;

    return `
      <div class="sh-page">
        <div class="sh-page-head">
          <div class="sh-page-title">Формулы цен по магазинам</div>
          <div class="sh-page-sub">
            Для каждого магазина можешь задать свою <b>математическую формулу</b>, как считать цену от себестоимости.
            Переменная: <code>cost_price</code>. Поддерживаются: <code>+ − × ÷ ( )</code>.
            <br>Примеры:
            <code>cost_price*2.2+252</code>,
            <code>cost_price*1.87+191</code>,
            <code>(cost_price*2.4+214)*0.99</code>.
            <br>Работает только когда у товара заполнена <b>себестоимость</b>.
          </div>
        </div>

        <!-- Тест-цена для предпросмотра -->
        <div class="sh-card">
          <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg2);border-radius:8px">
            <span style="font-size:12px;color:var(--muted);font-weight:600">${I.brain('', 14)} Тестовая себестоимость:</span>
            <input id="test-cost" class="ym-input" type="number" value="${testCost}" style="max-width:140px" oninput="window.settingsHub.refreshFormulaPreview()">
            <span style="font-size:11px;color:var(--muted)">для предпросмотра результатов</span>
          </div>
        </div>

        <!-- Формулы по магазинам -->
        <div class="sh-card" style="padding:0">
          <table class="an-table">
            <thead><tr>
              <th>Магазин</th>
              <th style="min-width:340px">Формула</th>
              <th style="text-align:right">Результат при ${testCost} ₽</th>
              <th style="text-align:center">Активна</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${this.stores.map(s => {
                const existing = formulas.find(f => f.store_id === s.id);
                const formula = existing?.formula ?? '';
                const enabled = existing?.enabled ?? false;
                const preview = formula
                  ? evaluateFormula(formula, testCost)
                  : null;
                const mpColor = s._mp === 'ozon' ? '#005bff' : s._mp === 'yandex' ? '#fc3f1d' : '#cb11ab';
                return `
                  <tr data-store-id="${s.id}">
                    <td>
                      <div style="display:flex;align-items:center;gap:8px">
                        <span style="width:10px;height:10px;border-radius:50%;background:${mpColor}"></span>
                        <div style="min-width:0">
                          <div style="font-size:13px;font-weight:600">${this.esc(s.name)}</div>
                          <div style="font-size:10px;color:var(--muted);text-transform:uppercase">${s._mp}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <input class="ym-input sh-formula-inp" data-store="${s.id}"
                        value="${this.esc(formula)}"
                        placeholder="cost_price * 2.2 + 252"
                        style="font-family:monospace;font-size:12px"
                        oninput="window.settingsHub.refreshFormulaPreview()">
                    </td>
                    <td style="text-align:right;font-family:monospace;font-size:12px" id="prev-${s.id}">
                      ${preview && preview.ok ? `<b>${Math.round(preview.value).toLocaleString('ru')} ₽</b>` : preview ? `<span style="color:#ef4444">${this.esc(preview.error)}</span>` : '<span style="color:var(--muted)">—</span>'}
                    </td>
                    <td style="text-align:center">
                      <input type="checkbox" class="sh-formula-on" data-store="${s.id}" ${enabled ? 'checked' : ''} style="accent-color:#005bff">
                    </td>
                    <td style="text-align:right">
                      <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.settingsHub.saveFormula('${s.id}')">Сохранить</button>
                      ${existing ? `
                        <button class="oz-tab-btn" onclick="window.settingsHub.removeFormula('${s.id}')" title="Удалить">
                          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 4h10M5 4V2h4v2M4 4l1 9h4l1-9"/></svg>
                        </button>
                      ` : ''}
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  refreshFormulaPreview(): void {
    const testCost = parseFloat((document.getElementById('test-cost') as HTMLInputElement)?.value ?? '1000') || 1000;
    document.querySelectorAll<HTMLInputElement>('.sh-formula-inp').forEach(inp => {
      const storeId = inp.dataset.store!;
      const cell = document.getElementById(`prev-${storeId}`);
      if (!cell) return;
      const formula = inp.value.trim();
      if (!formula) {
        cell.innerHTML = '<span style="color:var(--muted)">—</span>';
        return;
      }
      const r = evaluateFormula(formula, testCost);
      cell.innerHTML = r.ok
        ? `<b>${Math.round(r.value).toLocaleString('ru')} ₽</b>`
        : `<span style="color:#ef4444">${this.esc(r.error)}</span>`;
    });
  }

  saveFormula(storeId: string): void {
    const inp = document.querySelector<HTMLInputElement>(`.sh-formula-inp[data-store="${storeId}"]`);
    const toggle = document.querySelector<HTMLInputElement>(`.sh-formula-on[data-store="${storeId}"]`);
    if (!inp) return;
    const formula = inp.value.trim();
    if (!formula) {
      priceFormulasDb.remove(storeId);
      this.render();
      return;
    }
    const valid = validateFormula(formula);
    if (!valid.ok) {
      alert(`Ошибка формулы: ${valid.error}`);
      return;
    }
    priceFormulasDb.set(storeId, formula, toggle?.checked ?? true);
    this.render();
  }

  removeFormula(storeId: string): void {
    if (!confirm('Удалить формулу для этого магазина?')) return;
    priceFormulasDb.remove(storeId);
    this.render();
  }

  // ─────────────────────────────────────────────────────────────
  //   PAGE: Import / Export XLSX
  // ─────────────────────────────────────────────────────────────

  private renderImportExport(): string {
    const customCols = this.columns;
    const groupName = window.app?.getActiveGroupName?.() ?? null;
    const offersCount = this.getGroupOffers().length;
    return `
      <div class="sh-page">
        <div class="sh-page-head">
          <div class="sh-page-title">Шаблоны заполнения</div>
          <div class="sh-page-sub">
            <b>Контекст:</b> ${groupName
              ? `<span class="sh-context-tag">${I.package('', 14)} ${this.esc(groupName)} · ${offersCount} товаров</span>`
              : `<span class="sh-context-tag">${I.package('', 14)} Все группы · ${offersCount} товаров</span>`}
            <br>Шаблон будет содержать <b>только артикулы выбранной группы</b> и колонки для заполнения (Себестоимость + кастомные). Чтобы переключиться — открой нужную группу в разделе «Товары».
          </div>
        </div>

        <div class="sh-card">
          <div class="sh-card-title">${I.download('', 16)} Экспорт</div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="window.settingsHub.exportTemplate()">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M8 2v8M5 7l3 3 3-3M2 13h12"/></svg>
              Скачать пустой шаблон
            </button>
            <button class="btn" onclick="window.settingsHub.exportWithValues()">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M8 2v8M5 7l3 3 3-3M2 13h12"/></svg>
              Скачать с текущими данными
            </button>
            <span style="font-size:11px;color:var(--muted)">
              Колонок: <b>${customCols.length}</b>
            </span>
          </div>
        </div>

        <div class="sh-card">
          <div class="sh-card-title">${I.upload('', 16)} Импорт</div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <input type="file" id="import-file" accept=".xlsx,.xls" style="font-size:12px"
              onchange="window.settingsHub.previewImport(this.files)">
            <span style="font-size:11px;color:var(--muted)">Выбери XLSX — покажем превью</span>
          </div>

          ${this.importPreview ? this.renderImportPreview() : ''}
        </div>
      </div>
    `;
  }

  private renderImportPreview(): string {
    const p = this.importPreview!;
    return `
      <div style="margin-top:14px;padding:14px;background:var(--bg2);border-radius:10px;border:1px solid var(--border)">
        <div style="font-weight:700;margin-bottom:10px">Превью импорта</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
          <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase">Всего строк</div><div style="font-size:18px;font-weight:800">${p.total}</div></div>
          <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase">Новых записей</div><div style="font-size:18px;font-weight:800;color:#16a34a">${p.willInsert}</div></div>
          <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase">Будет перезаписано</div><div style="font-size:18px;font-weight:800;color:#f97316">${p.willUpdate.length}</div></div>
          <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase">Не найдено в группе</div><div style="font-size:18px;font-weight:800;color:#ef4444">${p.unknown}</div></div>
        </div>

        ${p.unknown > 0 ? `
          <div style="display:flex;align-items:flex-start;gap:8px;padding:10px 12px;background:#ef444415;border:1px solid #ef444430;border-radius:8px;margin-bottom:10px;font-size:12px">
            <span style="font-size:14px;flex-shrink:0">${I.alertTriangle('', 14)}</span>
            <div>
              <b style="color:#ef4444">${p.unknown} артикул(ов) из файла не найдено в этой группе</b> — они будут пропущены и <b>не добавлены</b>.
              <br>
              <span style="color:var(--muted)">xlsx-добавка дополняет только существующие товары. Чтобы добавить новые товары — используйте «Синхронизировать с МП».</span>
            </div>
          </div>` : ''}


        ${p.willUpdate.length > 0 ? `
          <details style="margin-bottom:10px">
            <summary style="cursor:pointer;font-size:12px;color:var(--muted);user-select:none">${I.alertTriangle('', 12)} Артикулы с существующими значениями (${p.willUpdate.length}) — будут перезаписаны</summary>
            <div style="max-height:200px;overflow:auto;margin-top:8px;font-size:11px;font-family:monospace">
              ${p.willUpdate.slice(0, 100).map(u => `
                <div style="padding:4px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px">
                  <b>${this.esc(u.offer_id)}</b>${copyButton(u.offer_id, 'Копировать артикул')} · ${this.esc(u.column)}: <span style="color:#94a3b8">${this.esc(String(u.oldValue))}</span> → <span style="color:#16a34a">${this.esc(String(u.newValue))}</span>
                </div>
              `).join('')}
              ${p.willUpdate.length > 100 ? `<div style="padding:4px 0;color:var(--muted)">…ещё ${p.willUpdate.length - 100} строк</div>` : ''}
            </div>
          </details>
        ` : ''}

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="window.settingsHub.applyImport(true)">
            ✓ Применить (перезаписать существующие)
          </button>
          <button class="btn" onclick="window.settingsHub.applyImport(false)">
            ⊕ Применить (НЕ трогать заполненные)
          </button>
          <button class="btn btn-danger" onclick="window.settingsHub.cancelImport()" style="margin-left:auto">
            Отмена
          </button>
        </div>
      </div>
    `;
  }

  // ── Export ───────────────────────────────────────────────────

  private getGroupOffers(): Array<{ offer_id: string; name: string; group: string }> {
    const w: any = window;
    const offers: Array<{ offer_id: string; name: string; box_name: string }> = w.app?.getActiveGroupOffers?.() ?? [];
    return offers.map(o => ({ offer_id: o.offer_id, name: o.name, group: o.box_name }));
  }

  async exportTemplate(): Promise<void> {
    await this._exportXlsx(false);
  }
  async exportWithValues(): Promise<void> {
    await this._exportXlsx(true);
  }

  private async _exportXlsx(withValues: boolean): Promise<void> {
    const offers = this.getGroupOffers();
    if (offers.length === 0) {
      alert('Нет товаров в активной группе. Открой группу в разделе «Товары» и попробуй снова.');
      return;
    }
    const allValues = customColumnsDb.getAllValues();
    const headers = ['offer_id', 'Группа', 'Название', ...this.columns.map(c => c.label)];
    const rows = offers.map(o => {
      const vals = allValues[o.offer_id] ?? {};
      return [
        o.offer_id, o.group, o.name,
        ...this.columns.map(c => withValues ? (vals[c.id] ?? '') : ''),
      ];
    });
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = headers.map((h, i) => ({ wch: i === 2 ? 40 : Math.max(h.length + 2, 16) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Товары');
    const date = new Date().toISOString().slice(0, 10);
    const groupName = window.app?.getActiveGroupName?.() ?? 'все_группы';
    XLSX.writeFile(wb, `${groupName}_${withValues ? 'с_данными' : 'шаблон'}_${date}.xlsx`);
  }

  // ── Import ───────────────────────────────────────────────────

  async previewImport(files: FileList | null): Promise<void> {
    if (!files || !files[0]) return;
    const file = files[0];
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: '' });

    const offers = this.getGroupOffers();
    const knownOffers = new Set(offers.map(o => o.offer_id));
    const allValues = customColumnsDb.getAllValues();

    // Сопоставляем заголовки колонок: label → column id
    const colByLabel = new Map<string, CustomColumn>();
    for (const c of this.columns) colByLabel.set(c.label, c);

    const updates: Array<{ offer_id: string; column_id: string; value: any; was: any }> = [];
    let unknownCount = 0;
    const insertSet = new Set<string>();

    for (const row of rows) {
      const offerId = String(row['offer_id'] ?? row['Артикул'] ?? '').trim();
      if (!offerId) continue;
      if (!knownOffers.has(offerId)) { unknownCount++; continue; }

      for (const [label, c] of colByLabel) {
        if (row[label] === undefined) continue;
        const raw = row[label];
        if (raw === '' || raw == null) continue;
        const value = c.data_type === 'number' ? Number(String(raw).replace(',', '.')) : String(raw);
        if (c.data_type === 'number' && !isFinite(value as number)) continue;
        const was = allValues[offerId]?.[c.id];
        updates.push({ offer_id: offerId, column_id: c.id, value, was });
        insertSet.add(offerId);
      }
    }

    const willUpdate = updates.filter(u => u.was != null && u.was !== '').map(u => ({
      offer_id: u.offer_id,
      column: this.columns.find(c => c.id === u.column_id)!.label,
      oldValue: u.was,
      newValue: u.value,
    }));

    this.importUpdates = updates.map(u => ({ offer_id: u.offer_id, column_id: u.column_id, value: u.value }));
    this.importPreview = {
      total: rows.length,
      willInsert: insertSet.size,
      willUpdate,
      unknown: unknownCount,
    };
    this.render();
  }

  applyImport(overwrite: boolean): void {
    if (!this.importUpdates.length) return;
    const allValues = customColumnsDb.getAllValues();
    const toApply = overwrite
      ? this.importUpdates
      : this.importUpdates.filter(u => allValues[u.offer_id]?.[u.column_id] == null || allValues[u.offer_id][u.column_id] === '');
    customColumnsDb.bulkSetValues(toApply);
    alert(`Применено: ${toApply.length} значений${overwrite ? '' : ' (только новые)'}`);
    this.importPreview = null;
    this.importUpdates = [];
    this.render();
  }

  cancelImport(): void {
    this.importPreview = null;
    this.importUpdates = [];
    this.render();
  }

  // ─────────────────────────────────────────────────────────────
  //   PAGE: Команда
  // ─────────────────────────────────────────────────────────────

  private async loadTeamData(): Promise<void> {
    const cid = companyService.getActiveId();
    if (!cid) return;
    try {
      const [members, pending, links] = await Promise.all([
        companyService.getMembers(cid),
        companyService.getPendingInvitations(cid),
        companyService.getInviteLinks(cid),
      ]);
      this.teamMembers = members.map((m: any) => ({
        id: m.id,
        user_id: m.user_id,
        role: m.role,
        joined_at: m.joined_at,
        first_name: m.users?.first_name ?? m.first_name ?? '—',
        telegram_username: m.users?.telegram_username ?? m.telegram_username ?? null,
        photo_url: m.users?.photo_url ?? m.photo_url ?? null,
        joined_via_link_id: m.joined_via_link_id ?? null,
      }));
      this.pendingInvites = pending;
      this.inviteLinks = links ?? [];
      this.render();
    } catch (e: unknown) {
      console.error('[Team]', e);
    }
  }

  private renderTeamPage(): string {
    const company = companyService.getActive();
    const myRole = company?.role ?? 'viewer';
    const canManage = myRole === 'owner' || myRole === 'admin';

    const roleLabel = (r: CompanyRole) => ({ owner: 'Владелец', admin: 'Администратор', manager: 'Менеджер', viewer: 'Наблюдатель' }[r] ?? r);
    const roleBadge = (r: CompanyRole) => {
      const colors: Record<CompanyRole, string> = { owner: '#7c3aed', admin: '#005bff', manager: '#059669', viewer: '#6b7280' };
      return `<span style="font-size:10px;padding:2px 8px;border-radius:20px;background:${colors[r]}22;color:${colors[r]};font-weight:600">${roleLabel(r)}</span>`;
    };

    const linkBadge = `<span title="Вступил по ссылке-приглашению" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:2px 7px;border-radius:20px;background:#00897b22;color:#00897b;font-weight:600">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="11" height="11"><path d="M8 3.5 10.5 1 13 3.5M10.5 1v8M6 10.5 3.5 13 1 10.5M3.5 13V5"/></svg>
      по ссылке
    </span>`;

    const membersHtml = this.teamMembers.length === 0
      ? `<div style="color:var(--muted);font-size:13px;padding:16px 0">Загрузка...</div>`
      : this.teamMembers.map(m => `
        <div class="sh-member-row">
          <div class="sh-member-avatar">${m.photo_url
            ? `<img src="${this.esc(m.photo_url)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover">`
            : `<div style="width:36px;height:36px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:var(--muted)">${(m.first_name?.[0] ?? '?').toUpperCase()}</div>`
          }</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px">
              ${this.esc(m.first_name)}
              ${m.joined_via_link_id ? linkBadge : ''}
            </div>
            <div style="font-size:11px;color:var(--muted)">${m.telegram_username ? '@' + this.esc(m.telegram_username) : ''}</div>
          </div>
          ${roleBadge(m.role)}
          ${canManage && m.role !== 'owner' ? `
            <select class="ym-input" style="width:130px;font-size:12px;padding:3px 6px" onchange="window.settingsHub.changeMemberRole('${this.esc(m.id)}', this.value)">
              <option value="admin"   ${m.role==='admin'   ? 'selected' : ''}>Администратор</option>
              <option value="manager" ${m.role==='manager' ? 'selected' : ''}>Менеджер</option>
              <option value="viewer"  ${m.role==='viewer'  ? 'selected' : ''}>Наблюдатель</option>
            </select>
            <button class="oz-tab-btn" onclick="window.settingsHub.removeMember('${this.esc(m.id)}')" title="Удалить" style="color:var(--red)">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9"/></svg>
            </button>
          ` : ''}
        </div>
      `).join('');

    const pendingHtml = this.pendingInvites.length === 0 ? '' : `
      <div style="margin-top:24px">
        <div style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Ожидают входа</div>
        ${this.pendingInvites.map(inv => `
          <div class="sh-member-row" style="opacity:.75">
            <div style="width:36px;height:36px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--muted)">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="16" height="16"><circle cx="8" cy="6" r="2.5"/><path d="M2 14c0-3 2.5-5 6-5s6 2 6 5"/></svg>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:13px">@${this.esc(inv.telegram_username)}</div>
              <div style="font-size:11px;color:var(--muted)">Ещё не вошёл</div>
            </div>
            ${roleBadge(inv.role)}
            ${canManage ? `
              <button class="oz-tab-btn" onclick="window.settingsHub.cancelInvite('${this.esc(inv.id)}')" title="Отменить приглашение" style="color:var(--red)">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8"/></svg>
              </button>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;

    const addFormHtml = canManage ? `
      <div class="sh-card" style="margin-top:24px">
        <div style="font-size:13px;font-weight:600;margin-bottom:12px">Добавить по username</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:180px">
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Telegram username</label>
            <input id="sh-invite-username" class="ym-input" type="text" placeholder="@username" style="width:100%">
          </div>
          <div>
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Роль</label>
            <select id="sh-invite-role" class="ym-input" style="min-width:140px">
              <option value="admin">Администратор</option>
              <option value="manager" selected>Менеджер</option>
              <option value="viewer">Наблюдатель</option>
            </select>
          </div>
          <button class="btn btn-primary" onclick="window.settingsHub.addMemberByUsername()" style="white-space:nowrap">Добавить</button>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:8px">Пользователь увидит компанию при следующем входе через Telegram, даже если ещё не зарегистрирован.</div>
      </div>
    ` : '';

    const activeLink = this.inviteLinks[0] ?? null;
    const inviteLinkHtml = canManage ? `
      <div class="sh-card" style="margin-top:24px;border:1.5px solid var(--border)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <div style="width:36px;height:36px;border-radius:10px;background:#005bff18;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg viewBox="0 0 20 20" fill="none" stroke="#005bff" stroke-width="1.6" stroke-linecap="round" width="20" height="20"><path d="M13 7l2.5-2.5a2.121 2.121 0 0 1 3 3L16 10M7 13l-2.5 2.5a2.121 2.121 0 0 1-3-3L4 10M8 12l4-4"/></svg>
          </div>
          <div>
            <div style="font-size:13px;font-weight:700">Ссылка-приглашение</div>
            <div style="font-size:11px;color:var(--muted)">Отправь ссылку — и человек сразу попадёт в компанию после входа</div>
          </div>
        </div>
        ${activeLink ? `
          <div style="background:var(--surface2,var(--bg2));border-radius:10px;padding:12px 14px;margin-bottom:12px">
            <div style="font-size:11px;color:var(--muted);margin-bottom:6px;font-weight:500">Ссылка для приглашения</div>
            <div style="display:flex;gap:8px;align-items:center">
              <input id="sh-invite-link-url" class="ym-input" readonly
                value="${this.esc(companyService.buildInviteUrl(activeLink.token))}"
                style="flex:1;font-size:12px;font-family:monospace;cursor:text;background:var(--bg,#fff)"
                onclick="this.select()">
              <button onclick="window.settingsHub.copyInviteLink()"
                style="flex-shrink:0;display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;background:#005bff;color:#fff;border:none;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="14" height="14"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3a1 1 0 0 1 1-1h8"/></svg>
                Скопировать
              </button>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <div style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px">
              <span>Роль:</span>
              <strong style="color:var(--text)">${roleLabel(activeLink.role as CompanyRole)}</strong>
            </div>
            <div style="width:1px;height:14px;background:var(--border)"></div>
            <div style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px">
              <span>Использований:</span>
              <strong style="color:var(--text)">${activeLink.use_count}</strong>
            </div>
            <button onclick="window.settingsHub.revokeInviteLink('${this.esc(activeLink.id)}')"
              style="margin-left:auto;font-size:12px;color:var(--red);background:none;border:none;cursor:pointer;padding:4px 0">
              Отозвать ссылку
            </button>
          </div>
        ` : `
          <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
            <div>
              <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Роль для новых участников</label>
              <select id="sh-link-role" class="ym-input" style="min-width:180px">
                <option value="admin">Администратор</option>
                <option value="manager" selected>Менеджер</option>
                <option value="viewer">Наблюдатель</option>
              </select>
            </div>
            <button onclick="window.settingsHub.createInviteLink()"
              style="display:flex;align-items:center;gap:6px;padding:8px 18px;border-radius:8px;background:#005bff;color:#fff;border:none;cursor:pointer;font-size:13px;font-weight:600">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><path d="M8 3v10M3 8h10"/></svg>
              Создать ссылку
            </button>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:10px">
            После создания ссылки скопируй её и отправь тем, кого хочешь добавить в команду.
          </div>
        `}
      </div>
    ` : '';

    return `
      <div class="sh-page">
        <div class="sh-page-head">
          <div class="sh-page-title">Команда</div>
        </div>
        <div class="sh-card">
          <div style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Участники (${this.teamMembers.length})</div>
          ${membersHtml}
          ${pendingHtml}
        </div>
        ${addFormHtml}
        ${inviteLinkHtml}
      </div>
    `;
  }

  async addMemberByUsername(): Promise<void> {
    const input = document.getElementById('sh-invite-username') as HTMLInputElement;
    const roleEl = document.getElementById('sh-invite-role') as HTMLSelectElement;
    const username = input?.value?.trim();
    const role = (roleEl?.value ?? 'manager') as CompanyRole;
    const cid = companyService.getActiveId();
    if (!username || !cid) return;
    try {
      await companyService.inviteByUsername(cid, username, role);
      input.value = '';
      window.app?.toast?.('Приглашение добавлено — пользователь увидит компанию при входе', 'success');
      this.loadTeamData();
    } catch (e: unknown) {
      window.app?.toast?.('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e), 'error');
    }
  }

  async removeMember(memberId: string): Promise<void> {
    if (!confirm('Удалить участника из компании?')) return;
    try {
      await companyService.removeMember(memberId);
      window.app?.toast?.('Участник удалён', 'success');
      this.loadTeamData();
    } catch (e: unknown) {
      window.app?.toast?.('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e), 'error');
    }
  }

  async changeMemberRole(memberId: string, role: string): Promise<void> {
    try {
      await companyService.updateMemberRole(memberId, role as CompanyRole);
      window.app?.toast?.('Роль обновлена', 'success');
    } catch (e: unknown) {
      window.app?.toast?.('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e), 'error');
    }
  }

  async cancelInvite(inviteId: string): Promise<void> {
    try {
      await companyService.cancelPendingInvitation(inviteId);
      window.app?.toast?.('Приглашение отменено', 'success');
      this.loadTeamData();
    } catch (e: unknown) {
      window.app?.toast?.('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e), 'error');
    }
  }

  async createInviteLink(): Promise<void> {
    const cid = companyService.getActiveId();
    if (!cid) return;
    const roleEl = document.getElementById('sh-link-role') as HTMLSelectElement | null;
    const role = (roleEl?.value ?? 'manager') as CompanyRole;
    try {
      await companyService.createInviteLink(cid, role);
      window.app?.toast?.('Ссылка создана', 'success');
      this.loadTeamData();
    } catch (e: unknown) {
      window.app?.toast?.('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e), 'error');
    }
  }

  async revokeInviteLink(linkId: string): Promise<void> {
    if (!confirm('Отозвать ссылку? Все, кто её получил, больше не смогут по ней войти.')) return;
    try {
      await companyService.deactivateInviteLink(linkId);
      this.inviteLinks = this.inviteLinks.filter(l => l.id !== linkId);
      window.app?.toast?.('Ссылка отозвана', 'success');
      this.loadTeamData();
    } catch (e: unknown) {
      window.app?.toast?.('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e), 'error');
    }
  }

  copyInviteLink(): void {
    const input = document.getElementById('sh-invite-link-url') as HTMLInputElement | null;
    if (!input) return;
    navigator.clipboard.writeText(input.value).then(() => {
      window.app?.toast?.('Ссылка скопирована', 'success');
    }).catch(() => {
      input.select();
      document.execCommand('copy');
      window.app?.toast?.('Ссылка скопирована', 'success');
    });
  }

  // ── Appearance ────────────────────────────────────────────────────────────

  private renderAppearancePage(): string {
    const theme = localStorage.getItem('simadesk_theme') ?? 'dark';
    const card = (id: string, label: string, desc: string, active: boolean, preview: string) => `
      <div onclick="window.settingsHub.setTheme('${id}')"
        style="cursor:pointer;border:2px solid ${active ? 'var(--accent)' : 'var(--border2)'};border-radius:14px;overflow:hidden;transition:border-color .15s;flex:1;min-width:180px;max-width:240px">
        <div style="height:100px;background:${preview};display:flex;align-items:center;justify-content:center;position:relative">
          <div style="width:70%;height:60%;border-radius:8px;background:${id === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'};border:1px solid ${id === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}"></div>
          <div style="position:absolute;bottom:8px;right:10px;width:32px;height:10px;border-radius:5px;background:${id === 'dark' ? '#d4f000' : '#c8e000'}"></div>
          ${active ? `<div style="position:absolute;top:8px;right:8px;width:20px;height:20px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center">
            <svg viewBox="0 0 12 12" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" style="width:10px;height:10px"><path d="M2 6l3 3 5-5"/></svg>
          </div>` : ''}
        </div>
        <div style="padding:10px 12px;background:var(--bg2)">
          <div style="font-size:12px;font-weight:700;color:var(--text)">${label}</div>
          <div style="font-size:11px;color:var(--text-2);margin-top:2px">${desc}</div>
        </div>
      </div>`;

    return `
      <div style="padding:28px 24px;max-width:600px">
        <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px">Внешний вид</div>
        <div style="font-size:12px;color:var(--text-2);margin-bottom:24px">Выберите тему интерфейса</div>

        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:32px">
          ${card('dark',  'Тёмная', 'По умолчанию',      theme === 'dark',  '#0f0f11')}
          ${card('light', 'Светлая', 'Молочный тон',     theme === 'light', '#e9e6df')}
        </div>

        <div style="padding:14px 16px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;font-size:12px;color:var(--text-2)">
          Тема сохраняется в браузере и применяется при следующем входе автоматически.
        </div>
      </div>`;
  }

  setTheme(theme: 'dark' | 'light'): void {
    localStorage.setItem('simadesk_theme', theme);
    if (theme === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
    this.render();
  }

  private esc(s: string | null | undefined): string {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
