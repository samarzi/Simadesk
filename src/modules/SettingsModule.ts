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
              <div class="settings-row-desc">Скачать все данные компании в JSON</div>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
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
    const keep = ['supabase_session', 'active_company_id', 'last_page'];
    const keys = Object.keys(localStorage).filter(k => !keep.includes(k));
    keys.forEach(k => localStorage.removeItem(k));
    showToast('Кэш очищен', 'success');
  }

  exportData(): void {
    showToast('Экспорт пока не доступен', 'info');
  }
}
