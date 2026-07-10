/**
 * SettingsModule — App-wide settings page:
 * - Theme (dark/light/system)
 * - Notifications preferences
 * - Language
 * - Data management (clear cache, export data)
 * - About / version info
 */

import { showToast } from '@/utils/toast';
import { detectSimaDeskExtension } from '@/services/extensionDetect';
import { companyService } from '@/services/companyService';
import { taskDb, reminderDb } from '@/services/taskDb';
import { producerDb, producerFieldDb } from '@/services/producerDb';
import { costPriceDb } from '@/services/costPriceDb';
import { autoReplyDb } from '@/services/autoReplyDb';
import { customColumnsDb } from '@/services/customColumnsDb';

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

          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">
                Статус
                ${this.extensionConnected === null
                  ? '<span style="margin-left:8px;font-size:12px;color:var(--text3)">Проверка…</span>'
                  : this.extensionConnected
                    ? '<span style="margin-left:8px;font-size:12px;color:#16a34a;font-weight:600">● Установлено</span>'
                    : '<span style="margin-left:8px;font-size:12px;color:#dc2626;font-weight:600">○ Не найдено</span>'}
              </div>
              <div class="settings-row-desc">
                Расширение для Chrome нужно для автоматизации складов/тарифов на WB, Ozon, Яндекс Маркете,

              </div>
            </div>
            <a href="/simadesk-extension.zip" download class="btn btn-primary" style="text-decoration:none;white-space:nowrap">
              Скачать расширение
            </a>
          </div>

          <div class="settings-row" style="display:block">
            <div class="settings-row-desc" style="line-height:1.7">
              <b style="color:var(--text)">Как установить:</b>
              <ol style="margin:6px 0 10px;padding-left:20px">
                <li>Скачайте архив кнопкой выше и распакуйте его в отдельную папку (правой кнопкой → «Извлечь все» / «Распаковать»).</li>
                <li>
                  Откройте страницу расширений вашего браузера — введите в адресную строку:
                  <ul style="margin:4px 0;padding-left:18px">
                    <li><code>chrome://extensions</code> — Google Chrome</li>
                    <li><code>browser://extensions</code> — Яндекс Браузер</li>
                    <li><code>edge://extensions</code> — Microsoft Edge</li>
                    <li><code>opera://extensions</code> — Opera</li>
                  </ul>
                  Другие браузеры на Chromium (Vivaldi, Brave, Arc и т.п.) — аналогично: <code>название-браузера://extensions</code> в адресной строке.
                  Если ваш браузер не на Chromium (например, Safari или Firefox) — расширение, к сожалению, не подойдёт,
                  используйте один из браузеров выше.
                </li>
                <li>В правом верхнем углу страницы расширений включите переключатель «Режим разработчика» (Developer mode).</li>
                <li>Нажмите появившуюся кнопку «Загрузить распакованное расширение» (Load unpacked) и выберите папку, которую вы распаковали на шаге 1.</li>
                <li>Расширение появится в списке, и статус выше на этой странице сменится на «Установлено» (может понадобиться обновить страницу SimaDesk).</li>
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
    const keep = ['server_session', 'active_company_id', 'last_page'];
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
      console.error('[exportData]', e);
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
        console.error('[importData]', e);
        showToast('Ошибка при импорте', 'error');
      }
    };
    input.click();
  }
}
