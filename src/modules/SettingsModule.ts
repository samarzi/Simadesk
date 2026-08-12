/**
 * SettingsModule — App-wide settings page:
 * - Theme (dark/light/system)
 * - Notifications preferences
 * - Language
 * - Data management (clear cache, export data)
 * - About / version info
 */

import { showToast } from '@/utils/toast';
import { detectSimaDeskExtension, sendConfigToExtension } from '@/services/extensionDetect';
import { companyService } from '@/services/companyService';
import { taskDb, reminderDb } from '@/services/taskDb';
import { producerDb, producerFieldDb } from '@/services/producerDb';
import { costPriceDb } from '@/services/costPriceDb';
import { autoReplyDb } from '@/services/autoReplyDb';
import { customColumnsDb } from '@/services/customColumnsDb';
import { debug } from '@/utils/debug';

export class SettingsModule {
  private el: HTMLElement;
  private extensionConnected: boolean | null = null; // null = проверка не завершена

  constructor(el: HTMLElement) {
    this.el = el;
  }

  show(): void {
    this.el.style.display = 'flex';
    this.render();
    detectSimaDeskExtension().then((ok) => {
      this.extensionConnected = ok;
      if (ok) sendConfigToExtension();
      this.render();
    });
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  render(): void {
    const notifEnabled = localStorage.getItem('settings_notif') !== 'off';
    const soundEnabled = localStorage.getItem('settings_sound') !== 'off';
    const dockAutohide = localStorage.getItem('settings_dock_autohide') === 'on';
    const isLight = localStorage.getItem('simadesk_theme') === 'light';

    this.el.innerHTML = `
      <div class="settings-page">
        <div class="settings-page-title">Настройки</div>

        <div class="settings-group">
          <div class="settings-group-title">Интерфейс</div>

          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Светлая тема</div>
              <div class="settings-row-desc">Молочный светлый фон вместо тёмного</div>
            </div>
            <label class="settings-toggle">
              <input type="checkbox" ${isLight ? 'checked' : ''} onchange="window.settingsModule.toggleTheme(this.checked)">
              <span class="settings-toggle-slider"></span>
            </label>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Скрытый док</div>
              <div class="settings-row-desc">Док сворачивается в светящуюся линию и раскрывается при наведении</div>
            </div>
            <label class="settings-toggle">
              <input type="checkbox" ${dockAutohide ? 'checked' : ''} onchange="window.settingsModule.toggleDockAutohide(this.checked)">
              <span class="settings-toggle-slider"></span>
            </label>
          </div>

        </div>

        <div class="settings-group">
          <div class="settings-group-title">Уведомления</div>

          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Push-уведомления</div>
              <div class="settings-row-desc">Уведомления о новых задачах и заказах</div>
            </div>
            <label class="settings-toggle">
              <input type="checkbox" ${notifEnabled ? 'checked' : ''} onchange="window.settingsModule.toggleSetting('notif', this.checked)">
              <span class="settings-toggle-slider"></span>
            </label>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Звуковые уведомления</div>
              <div class="settings-row-desc">Звук при поступлении нового уведомления</div>
            </div>
            <label class="settings-toggle">
              <input type="checkbox" ${soundEnabled ? 'checked' : ''} onchange="window.settingsModule.toggleSetting('sound', this.checked)">
              <span class="settings-toggle-slider"></span>
            </label>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">Расширение SimaDesk</div>

          <div class="settings-row" style="flex-wrap:wrap;gap:10px">
            <div class="settings-row-info">
              <div class="settings-row-label" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                Статус расширения
                ${this.extensionConnected === null
                  ? '<span style="font-size:12px;color:var(--text3)">⏳ Проверка…</span>'
                  : this.extensionConnected
                    ? '<span style="font-size:12px;color:#16a34a;font-weight:600">● Установлено и активно</span>'
                    : '<span style="font-size:12px;color:#dc2626;font-weight:600">○ Не найдено</span>'}
              </div>
              <div class="settings-row-desc" style="margin-top:4px">
                ${this.extensionConnected === false
                  ? 'Расширение не обнаружено. Скачайте, установите по инструкции ниже и <b style="color:var(--text)">перезагрузите эту страницу</b>.'
                  : 'Нужно для автоматизации складов, тарифов и цен на WB, Ozon, Яндекс Маркете.'}
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap">
              ${this.extensionConnected !== true ? `<a href="/simadesk-extension.zip" download class="btn btn-primary" style="text-decoration:none;white-space:nowrap">⬇ Скачать v1.5</a>` : ''}
              <button class="btn" id="ext-recheck-btn" style="white-space:nowrap">
                ${this.extensionConnected === null ? '⏳' : '🔄'} Проверить снова
              </button>
              ${this.extensionConnected === false ? `<button class="btn btn-primary" onclick="location.reload()" style="white-space:nowrap">↺ Перезагрузить страницу</button>` : ''}
            </div>
          </div>

          <div class="settings-row" style="display:block">
            <div class="settings-row-desc" style="line-height:1.7">
              <b style="color:var(--text)">Как установить:</b>
              <ol style="margin:6px 0 10px;padding-left:20px">
                <li>Скачайте архив кнопкой выше и распакуйте в отдельную папку (ПКМ → «Извлечь все»).</li>
                <li style="margin-bottom:10px">
                  Откройте страницу расширений — нажмите на свой браузер:
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
                    <button class="ext-url-copy" data-url="chrome://extensions" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);cursor:pointer;text-align:left;font-size:12px;color:var(--text)">
                      <svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#fff" stroke="#e0e0e0" stroke-width="0.5"/><circle cx="12" cy="12" r="4.5" fill="#4285F4"/><path d="M12 7.5h8.66A10 10 0 0 0 12 2v5.5z" fill="#EA4335"/><path d="M20.66 7.5H3.34A10 10 0 0 0 3.66 16.5l4.33-7.5H20.66z" fill="#EA4335" opacity="0"/><path d="M12 7.5H3.34A10 10 0 0 0 7.5 20.33L12 12.5 12 7.5z" fill="#34A853" opacity="0"/><circle cx="12" cy="12" r="4.5" fill="#4285F4"/><path fill="#EA4335" d="M12 7.5h8.66A10 10 0 0 0 12 2Z"/><path fill="#FBBC05" d="M3.34 7.5A10 10 0 0 0 7.5 20.33L12 12.5Z"/><path fill="#34A853" d="M12 22a10 10 0 0 0 8.66-5.5L12 12.5Z"/></svg>
                      <div><div style="font-weight:600;font-size:12px">Google Chrome</div><div style="font-size:10px;color:var(--text3);margin-top:1px">chrome://extensions</div></div>
                    </button>
                    <button class="ext-url-copy" data-url="browser://extensions" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);cursor:pointer;text-align:left;font-size:12px;color:var(--text)">
                      <svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#FF0000"/><text x="12" y="16" text-anchor="middle" fill="white" font-size="10" font-weight="bold">Я</text></svg>
                      <div><div style="font-weight:600;font-size:12px">Яндекс Браузер</div><div style="font-size:10px;color:var(--text3);margin-top:1px">browser://extensions</div></div>
                    </button>
                    <button class="ext-url-copy" data-url="edge://extensions" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);cursor:pointer;text-align:left;font-size:12px;color:var(--text)">
                      <svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0078d4"/><path d="M18 10c0 4-4 7-9 6.5 2 1.5 5.5 1.5 7.5-1 .5-1 1-3.5 1.5-5.5z" fill="#50e6ff"/><path d="M6 16c-1-2-1-6 2-8.5C10.5 5 15 5.5 17 8c-2-1.5-6-1.5-8 1.5-1.5 2-1.5 5.5-3 6.5z" fill="white" opacity="0.9"/></svg>
                      <div><div style="font-weight:600;font-size:12px">Microsoft Edge</div><div style="font-size:10px;color:var(--text3);margin-top:1px">edge://extensions</div></div>
                    </button>
                    <button class="ext-url-copy" data-url="opera://extensions" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);cursor:pointer;text-align:left;font-size:12px;color:var(--text)">
                      <svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#FF1B2D"/><ellipse cx="12" cy="12" rx="4.5" ry="7" fill="none" stroke="white" stroke-width="2"/></svg>
                      <div><div style="font-weight:600;font-size:12px">Opera</div><div style="font-size:10px;color:var(--text3);margin-top:1px">opera://extensions</div></div>
                    </button>
                  </div>
                  <div style="margin-top:6px;font-size:11px;color:var(--text3)">Нажмите на свой браузер — адрес скопируется. Вставьте в адресную строку и нажмите Enter.</div>
                </li>
                <li>Включите «Режим разработчика» (Developer mode) в правом верхнем углу страницы расширений.</li>
                <li>Нажмите «Загрузить распакованное расширение» (Load unpacked) и выберите папку из шага 1.</li>
                <li>Статус выше сменится на «Установлено» (обновите страницу SimaDesk если нужно).</li>
              </ol>
            </div>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">Данные</div>

          <div class="settings-row clickable" onclick="window.settingsModule.clearCache()">
            <div class="settings-row-info">
              <div class="settings-row-label">Очистить кэш</div>
              <div class="settings-row-desc">Удалит локальные данные, потребуется повторная загрузка</div>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </div>

          <div class="settings-row clickable" onclick="window.settingsModule.exportData()">
            <div class="settings-row-info">
              <div class="settings-row-label">Экспорт данных</div>
              <div class="settings-row-desc">Скачать задачи, напоминания, производителей, себестоимости и шаблоны ответов в JSON</div>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          </div>

          <div class="settings-row clickable" onclick="window.settingsModule.importData()">
            <div class="settings-row-info">
              <div class="settings-row-label">Импорт данных</div>
              <div class="settings-row-desc">Восстановить задачи, напоминания, производителей, себестоимости и шаблоны из JSON-файла</div>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5-5 5 5M12 3v12"/></svg>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">О приложении</div>
          <div class="settings-about">
            <div class="settings-about-name">SimaDesk</div>
            <div class="settings-about-ver">v1.0.0</div>
            <div class="settings-about-desc">SaaS-платформа управления маркетплейсами</div>
          </div>
        </div>
        <div style="height:80px;flex-shrink:0"></div>
      </div>
    `;
    const recheckBtn = this.el.querySelector<HTMLButtonElement>('#ext-recheck-btn');
    if (recheckBtn) {
      recheckBtn.addEventListener('click', () => {
        recheckBtn.textContent = '⏳ Проверка…';
        recheckBtn.disabled = true;
        this.extensionConnected = null;
        detectSimaDeskExtension().then((ok) => {
          this.extensionConnected = ok;
          if (ok) sendConfigToExtension();
          this.render();
        });
      });
    }

    this.el.querySelectorAll<HTMLElement>('.ext-url-copy').forEach(el => {
      el.addEventListener('click', () => {
        const url = el.dataset.url ?? '';
        const origHTML = el.innerHTML;
        const origBorder = el.style.borderColor;

        const showMsg = (html: string, color: string) => {
          el.innerHTML = html;
          el.style.borderColor = color;
          el.style.color = color;
          setTimeout(() => { el.innerHTML = origHTML; el.style.borderColor = origBorder; el.style.color = ''; }, 3000);
        };

        // chrome://, browser://, edge://, opera:// — cannot be opened from a web page (browser security).
        // Copy to clipboard and guide user to paste in address bar.
        navigator.clipboard.writeText(url).then(() => {
          showMsg('📋 Скопировано! Нажмите Ctrl+L → вставьте → Enter', '#f59e0b');
        }).catch(() => {
          showMsg('Вставьте вручную: ' + url, '#dc2626');
        });
      });
    });
  }

  toggleTheme(light: boolean): void {
    localStorage.setItem('simadesk_theme', light ? 'light' : 'dark');
    document.documentElement.classList.toggle('light', light);
  }

  toggleSetting(key: string, val: boolean): void {
    localStorage.setItem(`settings_${key}`, val ? 'on' : 'off');
    showToast('Настройка сохранена', 'success');
  }

  toggleDockAutohide(val: boolean): void {
    localStorage.setItem('settings_dock_autohide', val ? 'on' : 'off');
    const dock = document.getElementById('app-dock');
    if (dock) {
      dock.classList.toggle('dock-autohide', val);
    }
    showToast(val ? 'Док будет скрываться' : 'Док зафиксирован', 'success');
  }

  clearCache(): void {
    if (!confirm('Очистить локальный кэш? Данные будут перезагружены с сервера.')) return;
    const keep = ['server_session', 'active_company_id', 'last_page', 'docs_v1', 'docs_recent_v1'];
    const keys = Object.keys(localStorage).filter(k => !keep.includes(k));
    keys.forEach(k => localStorage.removeItem(k));
    showToast('Кэш очищен', 'success');
  }

  async exportData(): Promise<void> {
    const company = companyService.getActive();
    if (!company) { showToast('Нет активной компании', 'error'); return; }

    showToast('Подготовка экспорта…', 'info');

    try {
      const [tasks, reminders, producers, producerFieldDefs] = await Promise.all([
        taskDb.getTasks(),
        reminderDb.getReminders(),
        producerDb.list(),
        producerFieldDb.list(),
      ]);

      const payload = {
        _version: 1,
        _exported_at: new Date().toISOString(),
        _company_id: company.id,
        _company_name: company.name,
        tasks,
        reminders,
        producers,
        producerFieldDefs,
        costPrices: costPriceDb.all(),
        autoReply: {
          settings: autoReplyDb.getSettings(),
          templates: autoReplyDb.getTemplates(),
        },
        customColumns: {
          columns: customColumnsDb.getColumns(),
          values: customColumnsDb.getAllValues(),
        },
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `simadesk-export-${date}.json`;
      a.click();
      URL.revokeObjectURL(url);

      showToast('Данные экспортированы', 'success');
    } catch (e) {
      debug.warn('[exportData]', e);
      showToast('Ошибка при экспорте', 'error');
    }
  }

  importData(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      let payload: any;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        showToast('Неверный формат файла', 'error');
        return;
      }

      if (payload._version !== 1) {
        showToast('Несовместимая версия файла', 'error');
        return;
      }

      if (!companyService.getActive()) { showToast('Нет активной компании', 'error'); return; }

      const taskCount = Array.isArray(payload.tasks) ? payload.tasks.length : 0;
      const reminderCount = Array.isArray(payload.reminders) ? payload.reminders.length : 0;
      const producerCount = Array.isArray(payload.producers) ? payload.producers.length : 0;

      if (!confirm(
        `Импортировать данные из файла?\n` +
        `Источник: ${payload._company_name ?? 'неизвестно'} (${payload._exported_at?.slice(0, 10) ?? '?'})\n\n` +
        `Будет создано: задач — ${taskCount}, напоминаний — ${reminderCount}, производителей — ${producerCount}.\n` +
        `Себестоимости, шаблоны ответов и пользовательские колонки будут перезаписаны.`,
      )) return;

      showToast('Импорт…', 'info');

      try {
        // Задачи — создаём новые записи (parent_id обнуляется, т.к. ID изменятся)
        if (Array.isArray(payload.tasks) && payload.tasks.length > 0) {
          for (const t of payload.tasks) {
            const { id: _id, company_id: _cid, created_at: _ca, updated_at: _ua, parent_id: _pid, ...fields } = t;
            await taskDb.createTask(fields as any);
          }
        }

        // Напоминания — создаём новые (task_id обнуляется, т.к. ID задач изменились)
        if (Array.isArray(payload.reminders) && payload.reminders.length > 0) {
          for (const r of payload.reminders) {
            const { id: _id, company_id: _cid, created_at: _ca, task_id: _tid, ...fields } = r;
            await reminderDb.createReminder({ ...fields, task_id: null });
          }
        }

        // Производители — создаём новые записи
        if (Array.isArray(payload.producers) && payload.producers.length > 0) {
          for (const p of payload.producers) {
            const { id: _id, company_id: _cid, created_at: _ca, updated_at: _ua, ...fields } = p;
            await producerDb.create(fields as any);
          }
        }

        // Поля производителей — создаём новые
        if (Array.isArray(payload.producerFieldDefs) && payload.producerFieldDefs.length > 0) {
          for (const f of payload.producerFieldDefs) {
            const { id: _id, company_id: _cid, created_at: _ca, ...fields } = f;
            await producerFieldDb.create(fields as any);
          }
        }

        // Себестоимости — перезаписываем локально
        if (Array.isArray(payload.costPrices) && payload.costPrices.length > 0) {
          costPriceDb.bulkSet(
            payload.costPrices.map((e: any) => ({ vendorCode: e.vendorCode, cost: e.cost })),
          );
        }

        // Шаблоны автоответа — заменяем полностью
        if (payload.autoReply) {
          if (payload.autoReply.settings) {
            autoReplyDb.setSettings(payload.autoReply.settings);
          }
          if (Array.isArray(payload.autoReply.templates)) {
            for (const t of payload.autoReply.templates) {
              autoReplyDb.addTemplate({ text: t.text, ratings: t.ratings });
            }
          }
        }

        // Пользовательские колонки — сначала структура, потом значения
        if (Array.isArray(payload.customColumns?.columns)) {
          for (const col of payload.customColumns.columns) {
            if (!col.system) {
              customColumnsDb.addColumn({
                label: col.label,
                data_type: col.data_type,
                show_in_table: col.show_in_table,
                description: col.description,
                box_id: col.box_id ?? null,
                order: col.order ?? 0,
              });
            }
          }
        }
        // структура: { [columnId]: { [offerId]: value } }
        if (payload.customColumns?.values) {
          const vals: Record<string, Record<string, any>> = payload.customColumns.values;
          for (const [columnId, rows] of Object.entries(vals)) {
            for (const [offerId, val] of Object.entries(rows as Record<string, any>)) {
              customColumnsDb.setValue(offerId, columnId, val);
            }
          }
        }

        showToast('Импорт завершён', 'success');
      } catch (e) {
        debug.warn('[importData]', e);
        showToast('Ошибка при импорте', 'error');
      }
    };
    input.click();
  }
}
