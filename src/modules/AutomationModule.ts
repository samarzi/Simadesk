/**
 * AutomationModule — UI для запуска автоматизации складов и тарифов.
 *
 * Три вкладки:
 *   1. Яндекс Склады  — настройка зон доставки
 *   2. Яндекс Тарифы  — настройка тарифных зон
 *   3. Озон Склады     — настройка зон складов Ozon
 *
 * Два режима работы:
 *   - Chrome Extension (основной) — расширение автоматизирует браузер пользователя
 *   - Локальный сервер (fallback) — server.py на порту 8899
 */

import { debug } from '@/utils/debug';
import { warehouseScanDb, WarehouseScanRecord } from '../services/warehouseScanDb';
import { automationReportDb } from '../services/automationReportDb';

// ── Типы ─────────────────────────────────────────────────────────────────────

type ScriptType = 'yandex-warehouses' | 'yandex-tariffs' | 'ozon-warehouses';
type TabKey = 'ya-warehouses' | 'ya-tariffs' | 'oz-warehouses';

interface LogsResponse {
  id: string;
  status: string;
  logs: string[];
  total: number;
}

// ── Конфигурация вкладок ─────────────────────────────────────────────────────

interface TabConfig {
  key: TabKey;
  label: string;
  icon: string;
  scriptType: ScriptType;
  color: string;
  modes?: { value: string; label: string; hint: string }[];
  needsWarehouseUrl: boolean;
  cityTemplate: 'cities' | 'zones';
  cityFormatHint: string;
}

const TABS: TabConfig[] = [
  {
    key: 'ya-warehouses',
    label: 'Яндекс Склады',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    scriptType: 'yandex-warehouses',
    color: '#fc3f1d',
    modes: [
      { value: 'С картой',  label: 'С картой',  hint: 'Быстрый режим — использует сохранённую карту регионов (karta.json)' },
      { value: 'Без карты', label: 'Без карты', hint: 'Построчный обход всех федеральных округов и районов' },
      { value: 'Анализ',    label: 'Анализ',    hint: 'Сканирует текущие настройки, сравнивает с загруженным списком, генерирует Excel-отчёт' },
      { value: 'Сканер',    label: 'Сканер',    hint: 'Строит karta.json — карту всех регионов/городов для режима «С картой»' },
    ],
    needsWarehouseUrl: true,
    cityTemplate: 'cities',
    cityFormatHint: 'Excel-файл (xlsx): столбец A — по одному городу в каждой строке. Строка 1 — заголовок (пропускается).',
  },
  {
    key: 'ya-tariffs',
    label: 'Яндекс Тарифы',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
    scriptType: 'yandex-tariffs',
    color: '#fc3f1d',
    modes: [
      { value: 'С картой',  label: 'С картой',  hint: 'Быстрый режим — использует сохранённую карту регионов (karta.json)' },
      { value: 'Без карты', label: 'Без карты', hint: 'Полное раскрытие дерева зон доставки' },
    ],
    needsWarehouseUrl: true,
    cityTemplate: 'zones',
    cityFormatHint: 'Excel-файл (xlsx): каждая колонка — зона (заголовок содержит слово «зона»), строки — города.',
  },
  {
    key: 'oz-warehouses',
    label: 'Озон Склады',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
    scriptType: 'ozon-warehouses',
    color: '#005bff',
    needsWarehouseUrl: true,
    cityTemplate: 'zones',
    cityFormatHint: 'Excel-файл (xlsx): каждая колонка — зона (заголовок содержит слово «зона»), строки — города.',
  },
];

// ── (Yandex warehouses scanned dynamically via extension) ───────────────────

// ── Константы ────────────────────────────────────────────────────────────────

const SERVER_URL = 'http://localhost:8899';
const LOG_POLL_MS = 1500;

// ══════════════════════════════════════════════════════════════════════════════
//  AutomationModule
// ══════════════════════════════════════════════════════════════════════════════

export class AutomationModule {
  private container: HTMLElement;
  private activeTab: TabKey = 'ya-warehouses';
  private serverOnline = false;
  private serverChecked = false;   // проверяем раз в сессию, не при каждом show()
  private extensionConnected = false;
  private extensionPort: any = null;
  private detectedExtensionId = '';

  // Состояние каждой вкладки
  private tabState: Record<TabKey, {
    taskId: string | null;
    status: string;
    logs: string[];
    logOffset: number;
    pollTimer: number | null;
    warehouseUrl: string;
    mode: string;
    citiesFile: File | null;
    citiesList: string[];
    zonesData: Record<string, string[]>;
    selectedZones: Set<string>;
    selectedWarehouseIdx: number;
    // Yandex scan state
    yandexWarehouses: { name: string; url: string; address: string }[];
    yandexSelectedWarehouse: number;
    yandexScanning: boolean;
    yandexScanTabId: number | null;
    // Ozon scan state
    ozonWarehouses: { name: string; index: number; zones: { name: string; title: string }[]; zonesCount: number }[];
    ozonSelectedWarehouse: number;
    ozonSelectedPageZones: Set<string>;
    ozonScanning: boolean;
    ozonScanTabId: number | null;
    ozonDiagRunning: boolean;
    ozonDiagResults: { whName: string; expected: number; found: number; zones: string[]; missing: boolean }[];
    ozonShowDiag: boolean;
    // Saved scans
    savedScans: WarehouseScanRecord[];
    selectedScanId: string | null;
    saveScanName: string;
    showSaveDialog: boolean;
    scansLoaded: boolean;
    editingScanId: string | null;
    editingScanName: string;
    taskStartedAt: string | null;
    urlError: string;
  }>;

  constructor(container: HTMLElement) {
    this.container = container;
    this.tabState = {} as any;
    for (const tab of TABS) {
      this.tabState[tab.key] = {
        taskId: null,
        status: 'idle',
        logs: [],
        logOffset: 0,
        pollTimer: null,
        warehouseUrl: '',
        mode: tab.modes?.[0]?.value ?? '',
        citiesFile: null,
        citiesList: [],
        zonesData: {},
        selectedZones: new Set(),
        selectedWarehouseIdx: -1,
        yandexWarehouses: [],
        yandexSelectedWarehouse: -1,
        yandexScanning: false,
        yandexScanTabId: null,
        ozonWarehouses: [],
        ozonSelectedWarehouse: -1,
        ozonSelectedPageZones: new Set(),
        ozonScanning: false,
        ozonScanTabId: null,
        ozonDiagRunning: false,
        ozonDiagResults: [],
        ozonShowDiag: false,
        savedScans: [],
        selectedScanId: null,
        saveScanName: '',
        showSaveDialog: false,
        scansLoaded: false,
        editingScanId: null,
        editingScanName: '',
        taskStartedAt: null,
        urlError: '',
      };
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    // Проверяем оба варианта подключения
    Promise.all([this.checkExtension(), this.checkServer(), this.loadSavedScans()]).then(() => this.render());
  }

  hide(): void {
    this.container.style.display = 'none';
    // Останавливаем все поллинги при уходе со страницы
    for (const tab of TABS) {
      const st = this.tabState[tab.key];
      if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
    }
  }

  // ── Server check ───────────────────────────────────────────────────────────

  private async checkServer(): Promise<void> {
    if (this.serverChecked) return;   // не повторяем — браузер логирует ERR_CONNECTION_REFUSED
    this.serverChecked = true;
    try {
      const r = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      this.serverOnline = d.status === 'ok';
    } catch {
      this.serverOnline = false;
    }
  }


  // ── Extension detection ────────────────────────────────────────────────

  private async checkExtension(): Promise<void> {
    const chrome = (window as any).chrome;
    if (!chrome?.runtime?.sendMessage) {
      this.extensionConnected = false;
      return;
    }

    // Пытаемся найти расширение по ID или через перебор
    const tryId = async (id: string): Promise<boolean> => {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(id, { type: 'ping' }, (res: any) => {
            if (chrome.runtime.lastError) { resolve(false); return; }
            if (res?.type === 'pong') { resolve(true); return; }
            resolve(false);
          });
        } catch { resolve(false); }
        setTimeout(() => resolve(false), 2000);
      });
    };

    // Проверяем через window event (расширение могло установить маркер)
    if (window.__SIMADESK_EXTENSION_ID) {
      const id = window.__SIMADESK_EXTENSION_ID;
      this.extensionConnected = await tryId(id);
      if (this.extensionConnected) this.detectedExtensionId = id;
      return;
    }

    this.extensionConnected = false;
  }

  // ── Load saved scans from DB ──────────────────────────────────────────────

  private async loadSavedScans(): Promise<void> {
    try {
      const [yandexScans, ozonScans] = await Promise.all([
        warehouseScanDb.getScans('yandex'),
        warehouseScanDb.getScans('ozon'),
      ]);
      // Yandex scans go to both ya-warehouses and ya-tariffs
      this.tabState['ya-warehouses'].savedScans = yandexScans;
      this.tabState['ya-warehouses'].scansLoaded = true;
      this.tabState['ya-tariffs'].savedScans = yandexScans;
      this.tabState['ya-tariffs'].scansLoaded = true;
      // Ozon scans
      this.tabState['oz-warehouses'].savedScans = ozonScans;
      this.tabState['oz-warehouses'].scansLoaded = true;
    } catch (e) {
      debug.warn('Failed to load saved scans:', e);
    }
  }

  private connectExtensionPort(): void {
    if (this.extensionPort || !this.detectedExtensionId) return;
    const chrome = (window as any).chrome;
    if (!chrome?.runtime?.connect) return;

    try {
      this.extensionPort = chrome.runtime.connect(this.detectedExtensionId, { name: 'simadesk-site' });
      this.extensionPort.onMessage.addListener((msg: any) => {
        this.handleExtensionMessage(msg);
      });
      this.extensionPort.onDisconnect.addListener(() => {
        this.extensionPort = null;
      });
    } catch { /* ignore */ }
  }

  private handleExtensionMessage(msg: any): void {
    if (msg.type === 'task-log') {
      const st = Object.values(this.tabState).find(s => s.taskId === msg.taskId);
      if (st) {
        st.logs.push(msg.line);
        // Обновляем лог-вьюер
        const viewer = this.container.querySelector('#auto-log-viewer');
        if (viewer) {
          const div = document.createElement('div');
          div.style.color = this.logColor(msg.line);
          div.textContent = msg.line;
          viewer.appendChild(div);
          viewer.scrollTop = viewer.scrollHeight;
        }
      }
    }
    if (msg.type === 'task-status') {
      const entry = Object.entries(this.tabState).find(([, s]) => s.taskId === msg.taskId);
      if (entry && msg.status !== entry[1].status) {
        entry[1].status = msg.status;
        if (msg.status === 'completed') {
          this.saveAutomationReport(entry[0] as TabKey);
        }
        this.render();
      }
    }
  }

  // ── Вспомогательные ────────────────────────────────────────────────────────

  private esc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private getTabConfig(): TabConfig {
    return TABS.find(t => t.key === this.activeTab)!;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(): void {
    const tab = this.getTabConfig();
    const st = this.tabState[this.activeTab];

    this.container.innerHTML = `
      <div style="padding:24px 32px 100px;max-width:960px;width:100%;margin:0 auto;font-family:var(--font);overflow-y:auto;flex:1">

        <!-- Header -->
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
          <div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center">
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div>
            <h2 style="margin:0;font-size:20px;font-weight:700;color:var(--text)">Автоматизация</h2>
            <span style="font-size:12px;color:var(--text-muted)">Запуск скриптов настройки складов и тарифов</span>
          </div>
          <div style="margin-left:auto;display:flex;align-items:center;gap:12px">
            <a href="/simadesk-extension.zip" download
              style="padding:6px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg);
                color:var(--text-muted);font-size:11px;font-weight:600;cursor:pointer;text-decoration:none;
                display:flex;align-items:center;gap:6px;transition:all .2s"
              onmouseenter="this.style.borderColor='#6366f1';this.style.color='#6366f1'"
              onmouseleave="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Скачать расширение
            </a>
            ${this.renderServerStatus()}
          </div>
        </div>

        <!-- Tabs -->
        <div style="display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid var(--border);padding-bottom:0">
          ${TABS.map(t => `
            <button class="auto-tab-btn" data-tab="${t.key}"
              style="padding:10px 18px;border:none;background:none;cursor:pointer;font-size:13px;font-weight:600;
                color:${this.activeTab === t.key ? t.color : 'var(--text-muted)'};
                border-bottom:2px solid ${this.activeTab === t.key ? t.color : 'transparent'};
                transition:all .2s;display:flex;align-items:center;gap:6px;white-space:nowrap">
              ${t.icon} ${t.label}
            </button>
          `).join('')}
        </div>

        <!-- Tab Content -->
        <div style="display:flex;flex-direction:column;gap:16px">

          <!-- Server offline warning -->
          ${!this.isConnected ? `
            <div style="padding:14px 18px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:10px;display:flex;align-items:flex-start;gap:12px">
              <svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" style="width:20px;height:20px;flex-shrink:0;margin-top:1px">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <div>
                <div style="font-size:13px;font-weight:600;color:#ef4444;margin-bottom:4px">Расширение не найдено</div>
                <div style="font-size:12px;color:var(--text-muted);line-height:1.5">
                  Установите расширение <b>SimaDesk Automation</b> для Яндекс Браузера / Chrome,
                  затем обновите страницу.
                </div>
                <button onclick="window.automationModule?.checkServerAndRerender()"
                  style="margin-top:8px;padding:6px 14px;border-radius:6px;border:1px solid rgba(239,68,68,.3);background:none;color:#ef4444;font-size:12px;font-weight:600;cursor:pointer">
                  Обновить
                </button>
              </div>
            </div>
          ` : ''}

          <!-- Settings card -->
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px">
            <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:16px;display:flex;align-items:center;gap:8px">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              Параметры запуска
            </div>

            ${tab.key === 'ya-warehouses' || tab.key === 'ya-tariffs' ? `
              ${this.renderScanSection(st, 'yandex')}
            ` : ''}

            ${tab.key === 'oz-warehouses' ? `
              ${this.renderScanSection(st, 'ozon')}
            ` : ''}

            ${tab.modes ? `
              <!-- Mode selector -->
              <div style="margin-bottom:14px">
                <label style="font-size:12px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:6px">
                  Режим работы
                </label>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                  ${tab.modes.map(m => `
                    <button class="auto-mode-btn" data-mode="${m.value}"
                      title="${this.esc(m.hint)}"
                      style="padding:8px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;
                        ${st.mode === m.value
                          ? `background:${tab.color};color:#fff;border:1px solid ${tab.color}`
                          : `background:var(--bg);color:var(--text-muted);border:1px solid var(--border)`}">
                      ${m.label}
                    </button>
                  `).join('')}
                </div>
                ${st.mode ? `
                  <div style="margin-top:6px;font-size:11px;color:var(--text-muted);font-style:italic">
                    ${this.esc(tab.modes.find(m => m.value === st.mode)?.hint ?? '')}
                  </div>
                ` : ''}
              </div>
            ` : ''}

            <!-- Cities import -->
            <div style="margin-bottom:14px">
              <label style="font-size:12px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:6px">
                Список городов
              </label>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <label style="padding:8px 16px;border-radius:8px;border:1px dashed var(--border);cursor:pointer;
                  font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:6px;transition:all .2s;
                  background:var(--bg)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                  ${st.citiesFile ? this.esc(st.citiesFile.name) : 'Загрузить Excel'}
                  <input type="file" accept=".xlsx,.xls" style="display:none" id="auto-cities-input"/>
                </label>
                <button onclick="window.automationModule?.downloadTemplate()"
                  style="padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg);
                    color:var(--text-muted);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .2s">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Скачать шаблон
                </button>
                ${st.citiesList.length > 0 ? `
                  <span style="font-size:11px;color:var(--text-muted);background:var(--bg);padding:4px 10px;border-radius:6px;border:1px solid var(--border)">
                    ${st.citiesList.length} город${this.pluralize(st.citiesList.length)}
                  </span>
                ` : ''}
              </div>
              <div style="margin-top:6px;font-size:11px;color:var(--text-muted);line-height:1.5">
                ${this.esc(tab.cityFormatHint)}
              </div>
            </div>

            ${tab.cityTemplate === 'zones' && Object.keys(st.zonesData).length > 0 ? `
              <!-- Zone selection -->
              <div style="margin-bottom:14px">
                <label style="font-size:12px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:8px">
                  Выбор зон (${st.selectedZones.size} из ${Object.keys(st.zonesData).length})
                </label>
                <div style="display:flex;gap:6px;margin-bottom:8px">
                  <button class="auto-zones-all-btn"
                    style="padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);
                      color:var(--text-muted);font-size:11px;cursor:pointer">Выбрать все</button>
                  <button class="auto-zones-none-btn"
                    style="padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);
                      color:var(--text-muted);font-size:11px;cursor:pointer">Снять все</button>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;
                  padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg)">
                  ${Object.entries(st.zonesData).map(([zoneName, cities]) => `
                    <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;
                      transition:background .15s;font-size:12px;color:var(--text)"
                      onmouseenter="this.style.background='var(--bg-card)'" onmouseleave="this.style.background='transparent'">
                      <input type="checkbox" class="auto-zone-cb" data-zone="${this.esc(zoneName)}"
                        ${st.selectedZones.has(zoneName) ? 'checked' : ''}
                        style="accent-color:${tab.color};width:16px;height:16px;cursor:pointer"/>
                      <span style="font-weight:600">${this.esc(zoneName)}</span>
                      <span style="color:var(--text-muted);font-size:11px">${cities.length} город${this.pluralize(cities.length)}</span>
                    </label>
                  `).join('')}
                </div>
              </div>
            ` : ''}

            <!-- Action buttons -->
            <div style="display:flex;gap:8px;margin-top:18px">
              ${st.status === 'running' ? `
                <button id="auto-stop-btn"
                  style="padding:10px 24px;border-radius:8px;border:none;background:#ef4444;color:#fff;font-size:13px;font-weight:600;
                    cursor:pointer;display:flex;align-items:center;gap:8px;transition:all .2s">
                  <svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                  Остановить
                </button>
              ` : `
                <button id="auto-start-btn"
                  style="padding:10px 24px;border-radius:8px;border:none;background:${tab.color};color:#fff;font-size:13px;font-weight:600;
                    cursor:pointer;display:flex;align-items:center;gap:8px;transition:all .2s;
                    ${!this.isConnected ? 'opacity:.5;pointer-events:none' : ''}">
                  <svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  Запустить
                </button>
              `}
              ${st.status !== 'idle' && st.status !== 'running' ? `
                <button onclick="window.automationModule?.clearLogs()"
                  style="padding:10px 18px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text-muted);
                    font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px">
                    <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                  </svg>
                  Очистить
                </button>
              ` : ''}
            </div>
          </div>

          <!-- Status + Logs -->
          ${st.status !== 'idle' ? `
            <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden">
              <!-- Status bar -->
              <div style="padding:12px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;background:${this.getStatusBg(st.status)}">
                ${this.getStatusIcon(st.status)}
                <span style="font-size:13px;font-weight:600;color:var(--text)">${this.getStatusLabel(st.status)}</span>
                ${st.taskId ? `<span style="font-size:11px;color:var(--text-muted);margin-left:auto">ID: ${st.taskId}</span>` : ''}
                <button id="auto-copy-logs-btn"
                  style="margin-left:${st.taskId ? '8px' : 'auto'};padding:6px 14px;border-radius:6px;border:1px solid #6366f1;
                    background:none;color:#6366f1;font-size:11px;font-weight:600;cursor:pointer;transition:all .2s;flex-shrink:0;
                    display:flex;align-items:center;gap:4px"
                  onmouseenter="this.style.background='#6366f1';this.style.color='#fff'"
                  onmouseleave="this.style.background='none';this.style.color='#6366f1'">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                  Копировать логи
                </button>
              </div>
              <!-- Log viewer -->
              <div id="auto-log-viewer" style="height:350px;overflow-y:auto;padding:12px 16px;background:#0d1117;font-family:'JetBrains Mono',Consolas,monospace;font-size:11px;line-height:1.7">
                ${st.logs.length === 0 ? `
                  <div style="color:#6e7681;text-align:center;padding:40px 0">Ожидание логов...</div>
                ` : st.logs.map(l => `<div style="color:${this.logColor(l)}">${this.esc(l)}</div>`).join('')}
              </div>
            </div>
          ` : ''}

        </div>
      </div>
    `;

    this.bindEvents();
  }

  // ── Scan section render (shared for yandex / ozon) ─────────────────────────

  private renderScanSection(st: typeof this.tabState[TabKey], platform: 'yandex' | 'ozon'): string {
    const isYandex = platform === 'yandex';
    const warehouses = isYandex ? st.yandexWarehouses : st.ozonWarehouses;
    const selectedIdx = isYandex ? st.yandexSelectedWarehouse : st.ozonSelectedWarehouse;
    const scanning = isYandex ? st.yandexScanning : st.ozonScanning;
    const urlPlaceholder = isYandex
      ? 'https://partner.market.yandex.ru/business/.../warehouses?campaignId=...'
      : 'https://seller.ozon.ru/app/warehouse';
    const urlLabel = isYandex ? 'Ссылка на страницу складов Яндекс Маркет' : 'Ссылка на страницу складов Ozon';
    const scanLabel = isYandex ? 'Склад Яндекс' : 'Склад Ozon';

    // Saved scans dropdown
    const savedScansHtml = st.savedScans.length > 0 ? `
      <div style="margin-bottom:14px">
        <label style="font-size:12px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:6px">
          Сохранённые сканирования
        </label>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="auto-saved-scan-select"
            style="flex:1;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:13px;
              background:var(--bg);color:var(--text);outline:none;box-sizing:border-box;cursor:pointer">
            <option value="">— Новое сканирование —</option>
            ${st.savedScans.map(s => `
              <option value="${s.id}" ${st.selectedScanId === s.id ? 'selected' : ''}>
                ${this.esc(s.name)} (${s.warehouses.length} склад${this.pluralize(s.warehouses.length)})
              </option>
            `).join('')}
          </select>
          ${st.selectedScanId ? `
            <button id="auto-rename-scan-btn"
              style="padding:8px 12px;border-radius:8px;border:1px solid #6366f1;background:none;color:#6366f1;
                font-size:12px;cursor:pointer;flex-shrink:0" title="Переименовать">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button id="auto-delete-scan-btn"
              style="padding:8px 12px;border-radius:8px;border:1px solid #ef4444;background:none;color:#ef4444;
                font-size:12px;cursor:pointer;flex-shrink:0" title="Удалить скан">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          ` : ''}
        </div>
        ${st.editingScanId ? `
          <div style="display:flex;gap:8px;margin-top:8px">
            <input id="auto-edit-scan-name" type="text"
              value="${this.esc(st.editingScanName)}"
              style="flex:1;padding:8px 12px;border:1px solid #6366f1;border-radius:6px;font-size:13px;
                background:var(--bg);color:var(--text);outline:none"/>
            <button id="auto-edit-scan-save"
              style="padding:8px 14px;border-radius:6px;border:none;background:#6366f1;color:#fff;
                font-size:12px;font-weight:600;cursor:pointer">Сохранить</button>
            <button id="auto-edit-scan-cancel"
              style="padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:none;
                color:var(--text-muted);font-size:12px;cursor:pointer">Отмена</button>
          </div>
        ` : ''}
      </div>
    ` : '';

    // URL + scan button (shown when no saved scan selected)
    const showUrlAndScan = !st.selectedScanId;

    const urlHtml = showUrlAndScan ? `
      <div style="margin-bottom:14px">
        <label style="font-size:12px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:6px">
          ${urlLabel}
        </label>
        <input id="auto-scan-url" type="url"
          placeholder="${urlPlaceholder}"
          value="${this.esc(st.warehouseUrl || (isYandex ? '' : 'https://seller.ozon.ru/app/warehouse'))}"
          style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:13px;
            background:var(--bg);color:var(--text);outline:none;box-sizing:border-box;transition:border .2s"
          onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'"/>
        ${st.urlError ? `<div style="margin-top:6px;font-size:11px;color:#ef4444;font-weight:600">${this.esc(st.urlError)}</div>` : ''}
      </div>
    ` : '';

    // Warehouse list (from scan or saved)
    let warehouseListHtml = '';
    if (warehouses.length > 0) {
      warehouseListHtml = `
        <div style="margin-bottom:14px">
          <label style="font-size:12px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:6px">
            ${scanLabel}
          </label>
          <select id="auto-wh-select"
            style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:13px;
              background:var(--bg);color:var(--text);outline:none;box-sizing:border-box;cursor:pointer">
            <option value="-1" ${selectedIdx === -1 ? 'selected' : ''}>— Выберите склад —</option>
            ${warehouses.map((w: any, i: number) => {
              const zoneOk = !isYandex ? (w.zonesCount > 0 ? w.zones.length >= w.zonesCount : true) : true;
              const zoneInfo = !isYandex && w.zonesCount !== undefined ? ` (${w.zones.length}/${w.zonesCount} зон)` : '';
              const marker = !isYandex && !zoneOk ? ' [!]' : '';
              return `
              <option value="${i}" ${selectedIdx === i ? 'selected' : ''}>
                ${marker}${this.esc(w.name)}${isYandex && w.address ? ` — ${this.esc(w.address.substring(0, 60))}` : ''}${zoneInfo}
              </option>`;
            }).join('')}
          </select>

          ${isYandex && selectedIdx >= 0 ? `
            <div style="margin-top:6px;font-size:11px;color:var(--text-muted)">
              ${this.esc((warehouses as any[])[selectedIdx]?.url || '')}
            </div>
          ` : ''}

          ${!isYandex && selectedIdx >= 0 ? (() => {
            const wh = (warehouses as any[])[selectedIdx];
            if (!wh || !wh.zones || wh.zones.length === 0) return '<div style="margin-top:8px;font-size:11px;color:#ef4444;font-weight:600">[!] У этого склада не найдено зон. Попробуйте пересканировать — страница могла не успеть загрузиться.</div>';
            const zoneMissing = wh.zonesCount > 0 && wh.zones.length < wh.zonesCount;
            return `
              ${zoneMissing ? `
                <div style="margin-top:8px;padding:8px 12px;border-radius:6px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);
                  font-size:11px;color:#ef4444;font-weight:600;display:flex;align-items:center;gap:6px">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;flex-shrink:0">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  Найдено ${wh.zones.length} из ${wh.zonesCount} зон. Не все зоны загрузились — нажмите «Пересканировать» ниже.
                </div>
              ` : ''}
              <div style="margin-top:10px">
                <label style="font-size:12px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:6px">
                  Зоны на странице (${st.ozonSelectedPageZones.size} из ${wh.zones.length})
                </label>
                <div style="display:flex;gap:6px;margin-bottom:8px">
                  <button class="auto-ozon-zones-all"
                    style="padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);
                      color:var(--text-muted);font-size:11px;cursor:pointer">Выбрать все</button>
                  <button class="auto-ozon-zones-none"
                    style="padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);
                      color:var(--text-muted);font-size:11px;cursor:pointer">Снять все</button>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto;
                  padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg)">
                  ${wh.zones.map((z: any) => `
                    <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;
                      transition:background .15s;font-size:12px;color:var(--text)"
                      onmouseenter="this.style.background='var(--bg-card)'" onmouseleave="this.style.background='transparent'">
                      <input type="checkbox" class="auto-ozon-zone-cb" data-zone-title="${this.esc(z.title)}"
                        ${st.ozonSelectedPageZones.has(z.title) ? 'checked' : ''}
                        style="accent-color:#005bff;width:16px;height:16px;cursor:pointer"/>
                      <span style="font-weight:600">${this.esc(z.title)}</span>
                    </label>
                  `).join('')}
                </div>
              </div>
            `;
          })() : ''}

          <div style="display:flex;gap:8px;margin-top:8px">
            <button id="auto-rescan-btn"
              style="padding:6px 14px;border-radius:6px;border:1px solid var(--border);background:none;
                color:var(--text-muted);font-size:11px;cursor:pointer">
              Пересканировать
            </button>
            ${!st.selectedScanId && warehouses.length > 0 ? `
              <button id="auto-save-scan-btn"
                style="padding:6px 14px;border-radius:6px;border:1px solid #22c55e;background:none;
                  color:#22c55e;font-size:11px;font-weight:600;cursor:pointer">
                Сохранить скан
              </button>
            ` : ''}
          </div>
        </div>

        ${st.showSaveDialog ? `
          <div style="margin-bottom:14px;padding:12px;border:1px solid #22c55e;border-radius:8px;background:rgba(34,197,94,.05)">
            <label style="font-size:12px;font-weight:600;color:var(--text);display:block;margin-bottom:6px">
              Название сканирования
            </label>
            <div style="display:flex;gap:8px">
              <input id="auto-save-scan-name" type="text"
                placeholder="Например: Ozon Магазин 1 или Яндекс ИП Иванов"
                value="${this.esc(st.saveScanName)}"
                style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:13px;
                  background:var(--bg);color:var(--text);outline:none"/>
              <button id="auto-save-scan-confirm"
                style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#0a0a0a;
                  font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">
                Сохранить
              </button>
              <button id="auto-save-scan-cancel"
                style="padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:none;
                  color:var(--text-muted);font-size:12px;cursor:pointer">
                Отмена
              </button>
            </div>
          </div>
        ` : ''}
      `;
    } else if (showUrlAndScan) {
      warehouseListHtml = `
        <div style="margin-bottom:14px">
          <label style="font-size:12px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:6px">
            ${scanLabel}
          </label>
          <div style="display:flex;gap:8px;align-items:center">
            <button id="auto-scan-btn"
              style="padding:10px 18px;border-radius:8px;border:1px solid var(--border);background:var(--bg);
                color:var(--text);font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;
                ${scanning ? 'opacity:.6;pointer-events:none' : ''}
                ${!this.extensionConnected ? 'opacity:.5;pointer-events:none' : ''}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              ${scanning ? 'Сканирование...' : 'Сканировать склады'}
            </button>
            <span style="font-size:11px;color:var(--text-muted)">
              ${scanning ? 'Открывается страница...' : 'Откроется страница для поиска складов'}
            </span>
          </div>
        </div>
      `;
    }

    // Ozon diagnostics panel (after warehouse list)
    const diagHtml = !isYandex ? this.renderOzonDiagnostics(st) : '';

    return savedScansHtml + urlHtml + warehouseListHtml + diagHtml;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private bindEvents(): void {
    // Tab switching
    this.container.querySelectorAll('.auto-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeTab = (btn as HTMLElement).dataset.tab as TabKey;
        this.render();
      });
    });

    // Mode switching
    this.container.querySelectorAll('.auto-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const st = this.tabState[this.activeTab];
        st.mode = (btn as HTMLElement).dataset.mode!;
        this.render();
      });
    });

    // File input
    const fileInput = this.container.querySelector('#auto-cities-input') as HTMLInputElement | null;
    fileInput?.addEventListener('change', () => this.handleFileUpload(fileInput));

    // Unified scan URL input
    const scanUrlInput = this.container.querySelector('#auto-scan-url') as HTMLInputElement | null;
    scanUrlInput?.addEventListener('input', () => {
      this.tabState[this.activeTab].warehouseUrl = scanUrlInput.value;
    });

    // Scan button (unified)
    this.container.querySelector('#auto-scan-btn')?.addEventListener('click', () => {
      const tab = this.getTabConfig();
      if (tab.key === 'oz-warehouses') this.scanOzonWarehouses();
      else this.scanYandexWarehouses();
    });

    // Rescan button
    this.container.querySelector('#auto-rescan-btn')?.addEventListener('click', () => {
      const tab = this.getTabConfig();
      const st = this.tabState[this.activeTab];
      if (tab.key === 'oz-warehouses') {
        st.ozonWarehouses = [];
        st.ozonSelectedWarehouse = -1;
        st.ozonSelectedPageZones = new Set();
        this.render();
        this.scanOzonWarehouses();
      } else {
        st.yandexWarehouses = [];
        st.yandexSelectedWarehouse = -1;
        this.render();
        this.scanYandexWarehouses();
      }
    });

    // Warehouse select (unified)
    const whSelect = this.container.querySelector('#auto-wh-select') as HTMLSelectElement | null;
    whSelect?.addEventListener('change', () => {
      const tab = this.getTabConfig();
      const st = this.tabState[this.activeTab];
      const idx = parseInt(whSelect.value);
      if (tab.key === 'oz-warehouses') {
        st.ozonSelectedWarehouse = idx;
        st.ozonSelectedPageZones = new Set();
        if (idx >= 0 && st.ozonWarehouses[idx]) {
          for (const z of st.ozonWarehouses[idx].zones) {
            st.ozonSelectedPageZones.add(z.title);
          }
        }
        this.render();
      } else {
        st.yandexSelectedWarehouse = idx;
        if (idx >= 0 && st.yandexWarehouses[idx]) {
          st.warehouseUrl = st.yandexWarehouses[idx].url;
        }
      }
    });

    // Saved scan select
    const savedScanSelect = this.container.querySelector('#auto-saved-scan-select') as HTMLSelectElement | null;
    savedScanSelect?.addEventListener('change', () => {
      const st = this.tabState[this.activeTab];
      const scanId = savedScanSelect.value;
      if (!scanId) {
        st.selectedScanId = null;
        // Clear warehouses from saved scan
        const tab = this.getTabConfig();
        if (tab.key === 'oz-warehouses') {
          st.ozonWarehouses = [];
          st.ozonSelectedWarehouse = -1;
          st.ozonSelectedPageZones = new Set();
        } else {
          st.yandexWarehouses = [];
          st.yandexSelectedWarehouse = -1;
        }
        this.render();
        return;
      }
      st.selectedScanId = scanId;
      const scan = st.savedScans.find(s => s.id === scanId);
      if (scan) {
        st.warehouseUrl = scan.url;
        const tab = this.getTabConfig();
        if (tab.key === 'oz-warehouses') {
          st.ozonWarehouses = scan.warehouses;
          st.ozonSelectedWarehouse = -1;
          st.ozonSelectedPageZones = new Set();
          this.buildOzonDiagnostics(st);
        } else {
          st.yandexWarehouses = scan.warehouses;
          st.yandexSelectedWarehouse = -1;
        }
      }
      this.render();
    });

    // Delete saved scan
    this.container.querySelector('#auto-delete-scan-btn')?.addEventListener('click', async () => {
      const st = this.tabState[this.activeTab];
      if (!st.selectedScanId) return;
      try {
        await warehouseScanDb.deleteScan(st.selectedScanId);
        st.savedScans = st.savedScans.filter(s => s.id !== st.selectedScanId);
        st.selectedScanId = null;
        // Also clear from sibling tabs if yandex
        const tab = this.getTabConfig();
        if (tab.key === 'ya-warehouses') this.tabState['ya-tariffs'].savedScans = st.savedScans;
        if (tab.key === 'ya-tariffs') this.tabState['ya-warehouses'].savedScans = st.savedScans;
        this.showToast('Скан удалён', 'success');
        this.render();
      } catch (e: unknown) {
        this.showToast(`Ошибка: ${(e instanceof Error ? e.message : String(e))}`, 'error');
      }
    });

    // Rename scan
    this.container.querySelector('#auto-rename-scan-btn')?.addEventListener('click', () => {
      const st = this.tabState[this.activeTab];
      if (!st.selectedScanId) return;
      const scan = st.savedScans.find(s => s.id === st.selectedScanId);
      st.editingScanId = st.selectedScanId;
      st.editingScanName = scan?.name || '';
      this.render();
    });
    const editNameInput = this.container.querySelector('#auto-edit-scan-name') as HTMLInputElement | null;
    editNameInput?.addEventListener('input', () => {
      this.tabState[this.activeTab].editingScanName = editNameInput.value;
    });
    this.container.querySelector('#auto-edit-scan-save')?.addEventListener('click', async () => {
      const st = this.tabState[this.activeTab];
      if (!st.editingScanId || !st.editingScanName.trim()) return;
      try {
        await warehouseScanDb.renameScan(st.editingScanId, st.editingScanName.trim());
        const scan = st.savedScans.find(s => s.id === st.editingScanId);
        if (scan) scan.name = st.editingScanName.trim();
        // Sync sibling
        const tab = this.getTabConfig();
        if (tab.key === 'ya-warehouses') this.tabState['ya-tariffs'].savedScans = st.savedScans;
        if (tab.key === 'ya-tariffs') this.tabState['ya-warehouses'].savedScans = st.savedScans;
        st.editingScanId = null;
        this.showToast('Скан переименован', 'success');
        this.render();
      } catch (e: unknown) {
        this.showToast(`Ошибка: ${(e instanceof Error ? e.message : String(e))}`, 'error');
      }
    });
    this.container.querySelector('#auto-edit-scan-cancel')?.addEventListener('click', () => {
      this.tabState[this.activeTab].editingScanId = null;
      this.render();
    });

    // Save scan dialog
    this.container.querySelector('#auto-save-scan-btn')?.addEventListener('click', () => {
      const st = this.tabState[this.activeTab];
      st.showSaveDialog = true;
      this.render();
    });
    this.container.querySelector('#auto-save-scan-cancel')?.addEventListener('click', () => {
      const st = this.tabState[this.activeTab];
      st.showSaveDialog = false;
      this.render();
    });
    const saveNameInput = this.container.querySelector('#auto-save-scan-name') as HTMLInputElement | null;
    saveNameInput?.addEventListener('input', () => {
      this.tabState[this.activeTab].saveScanName = saveNameInput.value;
    });
    this.container.querySelector('#auto-save-scan-confirm')?.addEventListener('click', () => this.saveScanToDb());

    // Copy logs button
    this.container.querySelector('#auto-copy-logs-btn')?.addEventListener('click', () => {
      const st = this.tabState[this.activeTab];
      if (st.logs.length === 0) return;
      const text = st.logs.join('\n');
      navigator.clipboard.writeText(text).then(() => {
        this.showToast('Логи скопированы в буфер обмена', 'success');
      }).catch(() => {
        this.showToast('Не удалось скопировать', 'error');
      });
    });

    // Zone checkboxes
    this.container.querySelectorAll('.auto-zone-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const st = this.tabState[this.activeTab];
        const zone = (cb as HTMLInputElement).dataset.zone!;
        if ((cb as HTMLInputElement).checked) {
          st.selectedZones.add(zone);
        } else {
          st.selectedZones.delete(zone);
        }
        this.updateCitiesListFromZones(st);
      });
    });

    // Select all / none zones
    this.container.querySelector('.auto-zones-all-btn')?.addEventListener('click', () => {
      const st = this.tabState[this.activeTab];
      st.selectedZones = new Set(Object.keys(st.zonesData));
      this.updateCitiesListFromZones(st);
      this.render();
    });
    this.container.querySelector('.auto-zones-none-btn')?.addEventListener('click', () => {
      const st = this.tabState[this.activeTab];
      st.selectedZones.clear();
      st.citiesList = [];
      this.render();
    });

    // Ozon zone checkboxes
    this.container.querySelectorAll('.auto-ozon-zone-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const st = this.tabState['oz-warehouses'];
        const title = (cb as HTMLInputElement).dataset.zoneTitle!;
        if ((cb as HTMLInputElement).checked) {
          st.ozonSelectedPageZones.add(title);
        } else {
          st.ozonSelectedPageZones.delete(title);
        }
      });
    });
    this.container.querySelector('.auto-ozon-zones-all')?.addEventListener('click', () => {
      const st = this.tabState['oz-warehouses'];
      if (st.ozonSelectedWarehouse >= 0 && st.ozonWarehouses[st.ozonSelectedWarehouse]) {
        st.ozonSelectedPageZones = new Set(st.ozonWarehouses[st.ozonSelectedWarehouse].zones.map(z => z.title));
        this.render();
      }
    });
    this.container.querySelector('.auto-ozon-zones-none')?.addEventListener('click', () => {
      const st = this.tabState['oz-warehouses'];
      st.ozonSelectedPageZones.clear();
      this.render();
    });

    // Ozon diagnostics toggle
    this.container.querySelector('#auto-ozon-diag-toggle')?.addEventListener('click', () => {
      const st = this.tabState['oz-warehouses'];
      st.ozonShowDiag = !st.ozonShowDiag;
      this.render();
    });

    // Rescan all problematic zones
    this.container.querySelector('#auto-ozon-rescan-all-zones')?.addEventListener('click', () => {
      this.rescanOzonZones();
    });

    // Rescan single warehouse zones
    this.container.querySelectorAll('.auto-ozon-rescan-wh').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.whIdx!);
        if (!isNaN(idx)) this.rescanOzonZones(idx);
      });
    });

    // Start / Stop
    const startBtn = this.container.querySelector('#auto-start-btn');
    startBtn?.addEventListener('click', () => this.startTask());

    const stopBtn = this.container.querySelector('#auto-stop-btn');
    stopBtn?.addEventListener('click', () => this.stopTask());
  }

  // ── Ozon scan ─────────────────────────────────────────────────────────────

  private scanOzonWarehouses(): void {
    const st = this.tabState['oz-warehouses'];
    if (!this.extensionConnected || !this.detectedExtensionId) {
      this.showToast('Расширение не подключено', 'error');
      return;
    }

    const ozonUrl = (st.warehouseUrl || 'https://seller.ozon.ru/app/warehouse').trim();
    if (!ozonUrl.match(/^https?:\/\/seller\.ozon\.ru\/app\/warehouse/)) {
      st.urlError = 'Неверная ссылка. Формат: https://seller.ozon.ru/app/warehouse';
      this.render();
      return;
    }
    st.urlError = '';

    st.ozonScanning = true;
    this.render();

    const chrome = (window as any).chrome;
    try {
      chrome.runtime.sendMessage(this.detectedExtensionId, {
        type: 'scan-ozon',
        url: ozonUrl,
      }, (res: any) => {
        st.ozonScanning = false;
        if (chrome.runtime.lastError || res?.error) {
          this.showToast(res?.error === 'not_authorized'
            ? 'Авторизуйтесь в Ozon Seller и попробуйте снова'
            : `Ошибка: ${res?.error || chrome.runtime.lastError?.message}`, 'error');
          this.render();
          return;
        }
        st.ozonWarehouses = res.warehouses || [];
        st.ozonScanTabId = res.scanTabId || null;
        if (st.ozonWarehouses.length === 0) {
          this.showToast('Склады не найдены на странице', 'warning');
        } else {
          this.showToast(`Найдено складов: ${st.ozonWarehouses.length}`, 'success');
        }
        // Автоматическая диагностика зон
        this.buildOzonDiagnostics(st);
        this.render();
      });
    } catch (e: unknown) {
      st.ozonScanning = false;
      this.showToast(`Ошибка: ${(e instanceof Error ? e.message : String(e))}`, 'error');
      this.render();
    }
  }

  // ── Ozon diagnostics ──────────────────────────────────────────────────────

  private buildOzonDiagnostics(st: typeof this.tabState[TabKey]): void {
    st.ozonDiagResults = st.ozonWarehouses.map(wh => ({
      whName: wh.name,
      expected: wh.zonesCount,
      found: wh.zones.length,
      zones: wh.zones.map(z => z.title),
      missing: wh.zonesCount > 0 && wh.zones.length < wh.zonesCount,
    }));
    // Авто-показ если есть проблемы
    const hasIssues = st.ozonDiagResults.some(d => d.missing);
    if (hasIssues) {
      st.ozonShowDiag = true;
    }
  }

  private renderOzonDiagnostics(st: typeof this.tabState[TabKey]): string {
    if (st.ozonWarehouses.length === 0) return '';

    const diag = st.ozonDiagResults;
    if (diag.length === 0) return '';

    const totalWh = diag.length;
    const okWh = diag.filter(d => !d.missing).length;
    const problemWh = diag.filter(d => d.missing).length;
    const totalZonesExpected = diag.reduce((s, d) => s + d.expected, 0);
    const totalZonesFound = diag.reduce((s, d) => s + d.found, 0);
    const allOk = problemWh === 0;

    return `
      <div style="margin-bottom:14px">
        <!-- Toggle button -->
        <button id="auto-ozon-diag-toggle"
          style="width:100%;padding:10px 14px;border:1px solid ${allOk ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'};
            border-radius:8px;background:${allOk ? 'rgba(34,197,94,.05)' : 'rgba(239,68,68,.05)'};
            cursor:pointer;font-size:12px;font-weight:600;color:var(--text);
            display:flex;align-items:center;gap:8px;transition:all .2s">
          ${allOk
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" style="width:16px;height:16px">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" style="width:16px;height:16px">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`}
          <span>Диагностика зон: ${allOk
            ? `✓ Все ${totalZonesFound} зон у ${totalWh} складов найдены`
            : `[!] ${problemWh} из ${totalWh} складов — не все зоны открыты (${totalZonesFound}/${totalZonesExpected})`}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            style="width:14px;height:14px;margin-left:auto;transition:transform .2s;
              ${st.ozonShowDiag ? 'transform:rotate(180deg)' : ''}">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        ${st.ozonShowDiag ? `
          <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;
            background:var(--bg);overflow:hidden">
            <!-- Summary row -->
            <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:11px;color:var(--text-muted);
              display:flex;gap:16px;flex-wrap:wrap">
              <span>Складов: <b style="color:var(--text)">${totalWh}</b></span>
              <span>Зон найдено: <b style="color:var(--text)">${totalZonesFound}</b> / ${totalZonesExpected}</span>
              <span style="color:#22c55e">✓ OK: <b>${okWh}</b></span>
              ${problemWh > 0 ? `<span style="color:#ef4444">✗ Проблемы: <b>${problemWh}</b></span>` : ''}
            </div>

            <!-- Per-warehouse details -->
            <div style="max-height:300px;overflow-y:auto">
              ${diag.map((d, idx) => `
                <div style="padding:8px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;
                  ${d.missing ? 'background:rgba(239,68,68,.04)' : ''}">
                  <!-- Status icon -->
                  ${d.missing
                    ? `<span style="width:20px;height:20px;border-radius:50%;background:rgba(239,68,68,.12);
                        display:flex;align-items:center;justify-content:center;flex-shrink:0">
                        <svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" style="width:12px;height:12px">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>`
                    : `<span style="width:20px;height:20px;border-radius:50%;background:rgba(34,197,94,.12);
                        display:flex;align-items:center;justify-content:center;flex-shrink:0">
                        <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" style="width:12px;height:12px">
                          <polyline points="20 6 9 17 4 12"/></svg></span>`}

                  <!-- Warehouse name -->
                  <div style="flex:1;min-width:0">
                    <div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                      ${this.esc(d.whName)}
                    </div>
                    ${d.found > 0 ? `
                      <div style="font-size:10px;color:var(--text-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                        ${d.zones.join(', ')}
                      </div>
                    ` : ''}
                  </div>

                  <!-- Zone count badge -->
                  <div style="padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;flex-shrink:0;
                    ${d.missing
                      ? 'background:rgba(239,68,68,.12);color:#ef4444'
                      : 'background:rgba(34,197,94,.12);color:#22c55e'}">
                    ${d.found} / ${d.expected} зон
                  </div>

                  <!-- Rescan single warehouse button -->
                  ${d.missing ? `
                    <button class="auto-ozon-rescan-wh" data-wh-idx="${idx}"
                      style="padding:4px 10px;border-radius:6px;border:1px solid rgba(59,130,246,.3);background:none;
                        color:#3b82f6;font-size:10px;font-weight:600;cursor:pointer;flex-shrink:0;white-space:nowrap">
                      Пересканировать
                    </button>
                  ` : ''}
                </div>
              `).join('')}
            </div>

            <!-- Actions -->
            <div style="padding:10px 14px;display:flex;gap:8px;align-items:center;border-top:1px solid var(--border)">
              ${problemWh > 0 ? `
                <button id="auto-ozon-rescan-all-zones"
                  style="padding:6px 14px;border-radius:6px;border:1px solid #3b82f6;background:rgba(59,130,246,.08);
                    color:#3b82f6;font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;
                    ${st.ozonDiagRunning ? 'opacity:.6;pointer-events:none' : ''}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;
                    ${st.ozonDiagRunning ? 'animation:spin 1s linear infinite' : ''}">
                    <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                  </svg>
                  ${st.ozonDiagRunning ? 'Пересканирование...' : 'Пересканировать проблемные'}
                </button>
              ` : ''}
              <span style="font-size:10px;color:var(--text-muted);margin-left:auto">
                ${problemWh > 0
                  ? 'Некоторые зоны не загрузились. Попробуйте пересканировать — страница могла не успеть подгрузиться.'
                  : 'Все зоны успешно обнаружены ✓'}
              </span>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  /** Пересканировать зоны одного или всех проблемных складов */
  private rescanOzonZones(warehouseIdx?: number): void {
    const st = this.tabState['oz-warehouses'];
    if (!this.extensionConnected || !this.detectedExtensionId) {
      this.showToast('Расширение не подключено', 'error');
      return;
    }

    const chrome = (window as any).chrome;
    const indicesToRescan: number[] = [];

    if (warehouseIdx !== undefined) {
      indicesToRescan.push(warehouseIdx);
    } else {
      // Все проблемные
      st.ozonDiagResults.forEach((d, i) => {
        if (d.missing) indicesToRescan.push(i);
      });
    }

    if (indicesToRescan.length === 0) return;

    st.ozonDiagRunning = true;
    this.render();

    const warehouseNames = indicesToRescan.map(i => st.ozonWarehouses[i]?.name).filter(Boolean);
    debug.log(`[AutoDiag] Пересканирование зон для складов: ${warehouseNames.join(', ')}`);

    // Отправляем запрос на пересканирование зон конкретных складов
    try {
      chrome.runtime.sendMessage(this.detectedExtensionId, {
        type: 'rescan-ozon-zones',
        url: st.warehouseUrl || 'https://seller.ozon.ru/app/warehouse',
        warehouseIndices: indicesToRescan.map(i => st.ozonWarehouses[i]?.index),
        scanTabId: st.ozonScanTabId,
      }, (res: any) => {
        st.ozonDiagRunning = false;
        if (chrome.runtime.lastError || res?.error) {
          // Fallback: если расширение не поддерживает rescan-ozon-zones, делаем полный ресканr
          debug.warn('[AutoDiag] rescan-ozon-zones не поддерживается, делаем полное сканирование');
          this.scanOzonWarehouses();
          return;
        }
        // Обновляем зоны для пересканированных складов
        if (res.warehouses) {
          for (let i = 0; i < indicesToRescan.length; i++) {
            const origIdx = indicesToRescan[i];
            const updated = res.warehouses[i];
            if (updated && st.ozonWarehouses[origIdx]) {
              const prev = st.ozonWarehouses[origIdx];
              debug.log(`[AutoDiag] Склад "${prev.name}": зон было ${prev.zones.length}, стало ${updated.zones?.length ?? 0}`);
              st.ozonWarehouses[origIdx] = {
                ...prev,
                zones: updated.zones || prev.zones,
                zonesCount: updated.zonesCount ?? prev.zonesCount,
              };
            }
          }
        }
        this.buildOzonDiagnostics(st);
        const stillMissing = st.ozonDiagResults.filter(d => d.missing).length;
        if (stillMissing === 0) {
          this.showToast('✓ Все зоны успешно найдены!', 'success');
        } else {
          this.showToast(`Ещё ${stillMissing} складов с недостающими зонами`, 'warning');
        }
        this.render();
      });
    } catch (e: unknown) {
      st.ozonDiagRunning = false;
      this.showToast(`Ошибка: ${(e instanceof Error ? e.message : String(e))}`, 'error');
      this.render();
    }
  }

  // ── Yandex scan ───────────────────────────────────────────────────────────

  private scanYandexWarehouses(): void {
    const st = this.tabState[this.activeTab];
    if (!this.extensionConnected || !this.detectedExtensionId) {
      this.showToast('Расширение не подключено', 'error');
      return;
    }

    const url = st.warehouseUrl?.trim();
    if (!url) {
      st.urlError = 'Введите ссылку на страницу складов';
      this.render();
      return;
    }
    if (!url.match(/^https?:\/\/partner\.market\.yandex\.ru\/business\/\d+\/warehouses/)) {
      st.urlError = 'Неверная ссылка. Формат: https://partner.market.yandex.ru/business/{ID}/warehouses?campaignId=...';
      this.render();
      return;
    }
    st.urlError = '';

    st.yandexScanning = true;
    this.render();

    const chrome = (window as any).chrome;
    try {
      chrome.runtime.sendMessage(this.detectedExtensionId, {
        type: 'scan-yandex',
        url,
      }, (res: any) => {
        st.yandexScanning = false;
        if (chrome.runtime.lastError || res?.error) {
          this.showToast(res?.error === 'not_authorized'
            ? 'Авторизуйтесь в Яндекс Маркете и попробуйте снова'
            : `Ошибка: ${res?.error || chrome.runtime.lastError?.message}`, 'error');
          this.render();
          return;
        }
        st.yandexWarehouses = res.warehouses || [];
        st.yandexScanTabId = res.scanTabId || null;
        if (st.yandexWarehouses.length === 0) {
          this.showToast('Склады не найдены на странице', 'warning');
        } else {
          this.showToast(`Найдено складов: ${st.yandexWarehouses.length}`, 'success');
        }
        this.render();
      });
    } catch (e: unknown) {
      st.yandexScanning = false;
      this.showToast(`Ошибка: ${(e instanceof Error ? e.message : String(e))}`, 'error');
      this.render();
    }
  }

  // ── Save scan to DB ────────────────────────────────────────────────────────

  private async saveScanToDb(): Promise<void> {
    const st = this.tabState[this.activeTab];
    const tab = this.getTabConfig();
    const name = st.saveScanName.trim();
    if (!name) {
      this.showToast('Введите название для сканирования', 'warning');
      return;
    }

    const isOzon = tab.key === 'oz-warehouses';
    const platform = isOzon ? 'ozon' as const : 'yandex' as const;
    const warehouses = isOzon ? st.ozonWarehouses : st.yandexWarehouses;

    if (warehouses.length === 0) {
      this.showToast('Нет данных для сохранения', 'warning');
      return;
    }

    try {
      const saved = await warehouseScanDb.saveScan({
        name,
        platform,
        url: st.warehouseUrl,
        warehouses,
      });
      st.savedScans = [saved, ...st.savedScans];
      st.selectedScanId = saved.id;
      st.showSaveDialog = false;
      st.saveScanName = '';
      // Sync to sibling yandex tabs
      if (!isOzon) {
        const sibling = tab.key === 'ya-warehouses' ? 'ya-tariffs' : 'ya-warehouses';
        this.tabState[sibling].savedScans = st.savedScans;
      }
      this.showToast('Сканирование сохранено', 'success');
      this.render();
    } catch (e: unknown) {
      this.showToast(`Ошибка: ${(e instanceof Error ? e.message : String(e))}`, 'error');
    }
  }

  // ── Save automation report on success ────────────────────────────────────

  private async saveAutomationReport(tabKey: TabKey): Promise<void> {
    const st = this.tabState[tabKey];
    const tab = TABS.find(t => t.key === tabKey);
    if (!tab || !st.taskStartedAt) return;

    // Parse logs to extract results
    let filled = 0, alreadySet = 0, notFound = 0, errors = 0;
    const details: any[] = [];
    for (const line of st.logs) {
      if (line.includes('✅') || line.includes('Заполнено') || line.includes('установлен')) {
        filled++;
        details.push({ city: this.extractCity(line), status: 'filled' });
      } else if (line.includes('уже') || line.includes('already') || line.includes('Уже установлен')) {
        alreadySet++;
        details.push({ city: this.extractCity(line), status: 'already_set' });
      } else if (line.includes('не найден') || line.includes('not found') || line.includes('Не найден')) {
        notFound++;
        details.push({ city: this.extractCity(line), status: 'not_found' });
      } else if (line.includes('❌') || line.includes('ERROR') || line.includes('Ошибка')) {
        errors++;
        details.push({ city: this.extractCity(line), status: 'error', message: line });
      }
    }
    const totalCities = filled + alreadySet + notFound + errors;

    // Determine warehouse name
    let warehouseName = '';
    if (tabKey === 'oz-warehouses' && st.ozonSelectedWarehouse >= 0) {
      warehouseName = st.ozonWarehouses[st.ozonSelectedWarehouse]?.name || '';
    } else if (st.yandexSelectedWarehouse >= 0) {
      warehouseName = st.yandexWarehouses[st.yandexSelectedWarehouse]?.name || '';
    }

    try {
      await automationReportDb.saveReport({
        script_type: tab.scriptType,
        warehouse_name: warehouseName || undefined,
        mode: st.mode || undefined,
        started_at: st.taskStartedAt,
        total_cities: totalCities || st.citiesList.length,
        filled,
        already_set: alreadySet,
        not_found: notFound,
        errors,
        details,
      });
      this.showToast('Отчёт сохранён', 'success');
    } catch (e) {
      debug.warn('Failed to save report:', e);
    }
  }

  private extractCity(line: string): string {
    // Try to extract city name from log line like "✅ Москва — установлено" or "→ Москва: не найден"
    const m = line.match(/(?:→|✅|❌|⚠️)\s*([^:—\-]+)/);
    return m ? m[1].trim() : line.substring(0, 80);
  }

  // ── Zones helper ───────────────────────────────────────────────────────────

  private updateCitiesListFromZones(st: typeof this.tabState[TabKey]): void {
    const all: string[] = [];
    for (const zone of st.selectedZones) {
      const cities = st.zonesData[zone];
      if (cities) all.push(...cities);
    }
    st.citiesList = all;
  }

  // ── File upload (read Excel with XLSX) ─────────────────────────────────────

  private async handleFileUpload(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;

    const st = this.tabState[this.activeTab];
    st.citiesFile = file;

    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

      const tab = this.getTabConfig();
      if (tab.cityTemplate === 'cities') {
        const cities: string[] = [];
        for (let i = 1; i < rows.length; i++) {
          const val = String(rows[i]?.[0] ?? '').trim();
          if (val) cities.push(val);
        }
        st.citiesList = cities;
        st.zonesData = {};
        st.selectedZones = new Set();
      } else {
        // Зоны: каждая колонка — зона, заголовок = имя зоны
        const zones: Record<string, string[]> = {};
        const headers = rows[0] ?? [];
        for (let col = 0; col < headers.length; col++) {
          const zoneName = String(headers[col] ?? '').trim();
          if (!zoneName) continue;
          const cities: string[] = [];
          for (let row = 1; row < rows.length; row++) {
            const val = String(rows[row]?.[col] ?? '').trim();
            if (val) cities.push(val);
          }
          if (cities.length > 0) {
            zones[zoneName] = cities;
          }
        }
        st.zonesData = zones;
        st.selectedZones = new Set(Object.keys(zones));
        this.updateCitiesListFromZones(st);
      }
    } catch (e) {
      debug.warn('Error reading Excel:', e);
      st.citiesList = [];
      st.zonesData = {};
      st.selectedZones = new Set();
    }

    this.render();
  }

  // ── Template download ──────────────────────────────────────────────────────

  downloadTemplate(): void {
    const tab = this.getTabConfig();
    const endpoint = tab.cityTemplate === 'cities' ? '/api/template/cities' : '/api/template/zones';
    window.open(`${SERVER_URL}${endpoint}`, '_blank');
  }

  // ── Start task ─────────────────────────────────────────────────────────────

  private async startTask(): Promise<void> {
    const tab = this.getTabConfig();
    const st = this.tabState[this.activeTab];

    if (!this.isConnected) return;

    // Валидация
    if ((tab.key === 'ya-warehouses' || tab.key === 'ya-tariffs') && st.yandexSelectedWarehouse === -1) {
      this.showToast('Сканируйте и выберите склад', 'warning');
      return;
    }
    if ((tab.key === 'ya-warehouses' || tab.key === 'ya-tariffs') && st.yandexSelectedWarehouse >= 0) {
      st.warehouseUrl = st.yandexWarehouses[st.yandexSelectedWarehouse].url;
    }
    if (tab.key === 'oz-warehouses') {
      if (st.ozonSelectedWarehouse === -1) {
        this.showToast('Сначала сканируйте и выберите склад', 'warning');
        return;
      }
      if (st.ozonSelectedPageZones.size === 0) {
        this.showToast('Выберите хотя бы одну зону', 'warning');
        return;
      }
      st.warehouseUrl = 'https://seller.ozon.ru/app/warehouse';
    }
    if ((tab.key === 'ya-warehouses' || tab.key === 'ya-tariffs') && !st.warehouseUrl.trim()) {
      this.showToast('Выберите склад', 'warning');
      return;
    }
    if (st.citiesList.length === 0) {
      this.showToast('Загрузите файл с городами', 'warning');
      return;
    }
    if (tab.cityTemplate === 'zones' && st.selectedZones.size === 0) {
      this.showToast('Выберите хотя бы одну зону', 'warning');
      return;
    }

    st.logs = [];
    st.logOffset = 0;
    st.status = 'running';
    st.taskStartedAt = new Date().toISOString();

    const taskParams: any = {
      warehouseUrl: st.warehouseUrl,
      cities: st.citiesList,
      mode: st.mode,
    };
    if ((tab.key === 'ya-warehouses' || tab.key === 'ya-tariffs') && st.yandexSelectedWarehouse >= 0) {
      const yaWh = st.yandexWarehouses[st.yandexSelectedWarehouse];
      taskParams.warehouseName = yaWh.name;
    }
    if (tab.cityTemplate === 'zones' && Object.keys(st.zonesData).length > 0) {
      const selectedZonesData: Record<string, string[]> = {};
      for (const zone of st.selectedZones) {
        if (st.zonesData[zone]) selectedZonesData[zone] = st.zonesData[zone];
      }
      taskParams.zones = selectedZonesData;
    }
    if (tab.key === 'oz-warehouses' && st.ozonSelectedWarehouse >= 0) {
      const ozonWh = st.ozonWarehouses[st.ozonSelectedWarehouse];
      taskParams.ozonWarehouseName = ozonWh.name;
      taskParams.ozonPageZones = [...st.ozonSelectedPageZones];
      taskParams.ozonScanTabId = st.ozonScanTabId;
    }

    // Приоритет: расширение > локальный сервер
    if (this.extensionConnected && this.detectedExtensionId) {
      this.startTaskViaExtension(tab.scriptType, taskParams, st);
    } else if (this.serverOnline) {
      this.startTaskViaServer(tab.scriptType, taskParams, st);
    }
  }

  private startTaskViaExtension(scriptType: ScriptType, params: any, st: any): void {
    const chrome = (window as any).chrome;
    try {
      chrome.runtime.sendMessage(this.detectedExtensionId, {
        type: 'start-task',
        scriptType,
        params,
      }, (res: any) => {
        if (chrome.runtime.lastError || res?.error) {
          st.status = 'error';
          st.logs.push(`[Ошибка] ${res?.error || chrome.runtime.lastError?.message}`);
          this.render();
          return;
        }
        st.taskId = res.task_id || res.taskId;
        this.render();
        // Подключаем порт для стриминга логов
        this.connectExtensionPort();
        // Также поллим на случай если порт не работает
        this.startExtensionLogPolling();
      });
    } catch (e: unknown) {
      st.status = 'error';
      st.logs.push(`[Ошибка] Расширение: ${(e instanceof Error ? e.message : String(e))}`);
      this.render();
    }
  }

  private async startTaskViaServer(scriptType: ScriptType, params: any, st: any): Promise<void> {
    try {
      const r = await fetch(`${SERVER_URL}/api/tasks/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: scriptType, params }),
      });
      const data = await r.json();
      if (data.error) {
        st.status = 'error';
        st.logs.push(`[Ошибка] ${data.error}`);
        this.render();
        return;
      }
      st.taskId = data.task_id;
      this.render();
      this.startLogPolling();
    } catch (e: unknown) {
      st.status = 'error';
      st.logs.push(`[Ошибка] Не удалось запустить: ${(e instanceof Error ? e.message : String(e))}`);
      this.render();
    }
  }

  private startExtensionLogPolling(): void {
    const st = this.tabState[this.activeTab];
    const currentTab = this.activeTab;
    const chrome = (window as any).chrome;
    if (!chrome?.runtime?.sendMessage || !this.detectedExtensionId) return;

    if (st.pollTimer) clearInterval(st.pollTimer);

    const poll = () => {
      const s = this.tabState[currentTab];
      if (!s.taskId) return;

      try {
        chrome.runtime.sendMessage(this.detectedExtensionId, {
          type: 'get-logs',
          taskId: s.taskId,
          since: s.logOffset,
        }, (data: any) => {
          if (chrome.runtime.lastError || !data) return;
          if (data.logs?.length) {
            s.logs.push(...data.logs);
            s.logOffset = data.total;
            const viewer = this.container.querySelector('#auto-log-viewer');
            if (viewer && this.activeTab === currentTab) {
              for (const line of data.logs) {
                const div = document.createElement('div');
                div.style.color = this.logColor(line);
                div.textContent = line;
                viewer.appendChild(div);
              }
              viewer.scrollTop = viewer.scrollHeight;
            }
          }
          if (data.status !== s.status) {
            s.status = data.status;
            if (data.status === 'completed') {
              this.saveAutomationReport(currentTab);
            }
            if (data.status !== 'running' && s.pollTimer) {
              clearInterval(s.pollTimer);
              s.pollTimer = null;
            }
            if (this.activeTab === currentTab) this.render();
          }
        });
      } catch { /* ignore */ }
    };

    poll();
    st.pollTimer = window.setInterval(poll, LOG_POLL_MS);
  }

  // ── Stop task ──────────────────────────────────────────────────────────────

  private async stopTask(): Promise<void> {
    const st = this.tabState[this.activeTab];
    if (!st.taskId) return;

    // Останавливаем через расширение или сервер
    if (this.extensionConnected && this.detectedExtensionId) {
      try {
        const chrome = (window as any).chrome;
        chrome.runtime.sendMessage(this.detectedExtensionId, {
          type: 'stop-task', taskId: st.taskId
        });
      } catch (e) { debug.warn('[AutomationModule] swallowed error', e); }
    } else {
      try {
        await fetch(`${SERVER_URL}/api/tasks/${st.taskId}/stop`, { method: 'POST' });
      } catch (e) { debug.warn('[AutomationModule] swallowed error', e); }
    }

    if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
    st.status = 'stopped';
    st.logs.push(`[${new Date().toLocaleTimeString('ru')}] Остановлено пользователем`);
    this.render();
  }

  // ── Log polling ────────────────────────────────────────────────────────────

  private startLogPolling(): void {
    const st = this.tabState[this.activeTab];
    const currentTab = this.activeTab;

    if (st.pollTimer) clearInterval(st.pollTimer);

    const poll = async () => {
      const s = this.tabState[currentTab];
      if (!s.taskId) return;

      try {
        const r = await fetch(`${SERVER_URL}/api/tasks/${s.taskId}/logs?since=${s.logOffset}`);
        const data: LogsResponse = await r.json();

        if (data.logs.length > 0) {
          s.logs.push(...data.logs);
          s.logOffset = data.total;

          // Обновляем только лог-вьюер, не весь DOM
          const viewer = this.container.querySelector('#auto-log-viewer');
          if (viewer && this.activeTab === currentTab) {
            for (const line of data.logs) {
              const div = document.createElement('div');
              div.style.color = this.logColor(line);
              div.textContent = line;
              viewer.appendChild(div);
            }
            viewer.scrollTop = viewer.scrollHeight;
          }
        }

        // Обновляем статус
        if (data.status !== s.status) {
          s.status = data.status;
          if (data.status === 'completed') {
            this.saveAutomationReport(currentTab);
          }
          if (data.status !== 'running') {
            if (s.pollTimer) { clearInterval(s.pollTimer); s.pollTimer = null; }
          }
          // Перерендериваем полностью для обновления кнопок / статуса
          if (this.activeTab === currentTab) this.render();
        }
      } catch {
        // Сервер упал
        s.status = 'error';
        s.logs.push(`[${new Date().toLocaleTimeString('ru')}] Потеряно соединение с сервером`);
        if (s.pollTimer) { clearInterval(s.pollTimer); s.pollTimer = null; }
        if (this.activeTab === currentTab) this.render();
      }
    };

    // Первый запрос сразу, далее интервал
    poll();
    st.pollTimer = window.setInterval(poll, LOG_POLL_MS);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  clearLogs(): void {
    const st = this.tabState[this.activeTab];
    st.logs = [];
    st.logOffset = 0;
    st.taskId = null;
    st.status = 'idle';
    this.render();
  }

  async checkServerAndRerender(): Promise<void> {
    this.serverChecked = false;   // сбрасываем флаг чтобы перепроверить
    await Promise.all([this.checkExtension(), this.checkServer()]);
    this.render();
  }

  private showToast(msg: string, type: 'warning' | 'error' | 'success' = 'warning'): void {
    const colors = { warning: '#f59e0b', error: '#ef4444', success: '#22c55e' };
    const toast = document.createElement('div');
    toast.textContent = msg;
    Object.assign(toast.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: '9999',
      padding: '12px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: '600',
      color: '#fff', background: colors[type],
      boxShadow: '0 4px 12px rgba(0,0,0,.15)',
      animation: 'fadeIn .3s',
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  private pluralize(n: number): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return '';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'а';
    return 'ов';
  }

  // ── Status rendering helpers ───────────────────────────────────────────────

  private get isConnected(): boolean {
    return this.extensionConnected || this.serverOnline;
  }

  private renderServerStatus(): string {
    if (this.extensionConnected) {
      return `<span style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#22c55e">
        <span style="width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;animation:pulse 2s infinite"></span>
        Расширение подключено
      </span>`;
    }
    if (this.serverOnline) {
      return `<span style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#22c55e">
        <span style="width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;animation:pulse 2s infinite"></span>
        Сервер онлайн
      </span>`;
    }
    return `<span style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#ef4444">
      <span style="width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block"></span>
      Не подключено
    </span>`;
  }

  private getStatusBg(status: string): string {
    switch (status) {
      case 'running':   return 'rgba(59,130,246,.06)';
      case 'completed': return 'rgba(34,197,94,.06)';
      case 'error':     return 'rgba(239,68,68,.06)';
      case 'stopped':   return 'rgba(245,158,11,.06)';
      default:          return 'transparent';
    }
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'running':
        return `<svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" style="width:16px;height:16px;animation:spin 1s linear infinite">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
      case 'completed':
        return `<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" style="width:16px;height:16px">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
      case 'error':
        return `<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" style="width:16px;height:16px">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
      case 'stopped':
        return `<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" style="width:16px;height:16px">
          <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
      default:
        return '';
    }
  }

  private getStatusLabel(status: string): string {
    switch (status) {
      case 'running':   return 'Выполняется...';
      case 'completed': return 'Завершено успешно';
      case 'error':     return 'Ошибка';
      case 'stopped':   return 'Остановлено';
      default:          return '';
    }
  }

  private logColor(line: string): string {
    if (line.includes('ERROR') || line.includes('Ошибка') || line.includes('❌')) return '#f87171';
    if (line.includes('WARNING') || line.includes('WARN'))  return '#fbbf24';
    if (line.includes('✅') || line.includes('SUCCESS') || line.includes('Завершён')) return '#4ade80';
    if (line.includes('INFO') || line.includes('→'))        return '#60a5fa';
    return '#8b949e';
  }
}
