import { I } from '@/utils/icons';

/**
 * HomeWidgets — реестр виджетов главной страницы (командный центр).
 *
 * Принцип: на КАЖДОМ виджете явно подписано, ЧЬИ это данные и ЗА КАКОЙ период:
 *   - маркетплейс(ы) и охват магазинов — строкой scope;
 *   - период — бейджем (СЕГОДНЯ / 30 ДНЕЙ / СЕЙЧАС и т.д.).
 *
 * Данные приходят ОДНИМ запросом (HomeDashboardModule) и раскладываются по
 * фиксированным id (`dw-*` / `k-*`). Отдельных запросов на виджет нет → без лагов.
 *
 * Размерная сетка: 4 колонки × строки по 116px. Виджет занимает cw×rh ячеек.
 */

export type ColSpan = 1 | 2 | 3 | 4;
export type RowSpan = 1 | 2 | 3 | 4;
export interface WidgetDims { cw: ColSpan; rh: RowSpan }

export type WidgetKind = 'counter' | 'dashboard';

export interface WidgetDef {
  id: string;
  title: string;
  description: string;
  kind: WidgetKind;
  defaultDims: WidgetDims;
  minDims: WidgetDims;
  maxDims: WidgetDims;
  icon: string;
  skeleton(): string;
}

// Единый текст охвата — все виджеты агрегируют все МП и все магазины.
const SCOPE_ALL = 'Все МП · все магазины';
const SCOPE_MP = 'Ozon · Я.Маркет · WB';

// ── Хранилище размеров ────────────────────────────────────────────────────────

const DIMS_KEY = 'home_widgets_dims_v3';
function companyKey(base: string): string {
  const cid = localStorage.getItem('active_company_id');
  return cid ? `${base}_${cid}` : base;
}
export function loadDims(): Record<string, WidgetDims> {
  try { return JSON.parse(localStorage.getItem(companyKey(DIMS_KEY)) || '{}'); } catch { return {}; }
}
export function saveDims(dims: Record<string, WidgetDims>): void {
  localStorage.setItem(companyKey(DIMS_KEY), JSON.stringify(dims));
}
export function resetDims(): void {
  localStorage.removeItem(companyKey(DIMS_KEY));
}
export function getWidgetDims(id: string): WidgetDims {
  const dims = loadDims();
  if (dims[id]) return dims[id];
  return WIDGETS[id]?.defaultDims ?? { cw: 1, rh: 1 };
}
export function setWidgetDims(id: string, dims: WidgetDims): void {
  const all = loadDims();
  all[id] = dims;
  saveDims(all);
}
export function clampDims(id: string, cw: number, rh: number): WidgetDims {
  const w = WIDGETS[id];
  if (!w) return { cw: 1, rh: 1 };
  const cwC = Math.max(w.minDims.cw, Math.min(w.maxDims.cw, Math.round(cw))) as ColSpan;
  const rhC = Math.max(w.minDims.rh, Math.min(w.maxDims.rh, Math.round(rh))) as RowSpan;
  return { cw: cwC, rh: rhC };
}

// ── Счётчик (KPI) ─────────────────────────────────────────────────────────────
//
//   ┌ [icon]                       [ПЕРИОД]
//   │  VALUE            ▲ +12%
//   │  Метрика
//   └  🌐 Все МП · все магазины     (охват — чётко подписан)
//
// elemId используется модулем для заливки данных (-val / -trend / -spark).

interface KpiCfg { id: string; elemId: string; icon: string; label: string; period: string; color: string; }

function kpiSkeleton(c: KpiCfg): string {
  return `<div class="cmd-kpi" id="${c.elemId}" style="--kpi:${c.color}">
    <div class="cmd-kpi-top">
      <div class="cmd-kpi-icon">${c.icon}</div>
      <div class="cmd-kpi-period">${c.period}</div>
    </div>
    <div class="cmd-kpi-main">
      <div class="cmd-kpi-valrow">
        <div class="cmd-kpi-val" id="${c.elemId}-val">—</div>
        <div class="cmd-kpi-trend" id="${c.elemId}-trend" style="display:none"></div>
      </div>
      <div class="cmd-kpi-bottom">
        <span class="cmd-kpi-label">${c.label}</span>
        <span class="cmd-kpi-scope">${I.globe('', 11)}<span>${SCOPE_ALL}</span></span>
      </div>
    </div>
    <div class="cmd-kpi-spark" id="${c.elemId}-spark"></div>
  </div>`;
}

const KPI_MIN: WidgetDims = { cw: 1, rh: 1 };
const KPI_DEF: WidgetDims = { cw: 2, rh: 1 };
const KPI_MAX: WidgetDims = { cw: 2, rh: 2 };

/** Конфиги счётчиков — модуль итерирует по ним при заливке. */
export const KPIS: KpiCfg[] = [
  { id: 'k-rev-today',    elemId: 'k-rev-today',    icon: I.banknote(),    label: 'Выручка',       period: 'СЕГОДНЯ', color: '#16a34a' },
  { id: 'k-rev-30',       elemId: 'k-rev-30',       icon: I.trendingUp(),  label: 'Выручка',       period: '30 ДНЕЙ', color: '#059669' },
  { id: 'k-orders-today', elemId: 'k-orders-today', icon: I.bag(),         label: 'Заказов',       period: 'СЕГОДНЯ', color: '#f59e0b' },
  { id: 'k-orders-30',    elemId: 'k-orders-30',    icon: I.cart(),        label: 'Заказов',       period: '30 ДНЕЙ', color: '#d97706' },
  { id: 'k-new',          elemId: 'k-new',          icon: I.sparkle(),     label: 'Новые (сборка)', period: 'СЕЙЧАС',  color: '#ea580c' },
  { id: 'k-ship',         elemId: 'k-ship',         icon: I.truck(),       label: 'К отгрузке',    period: 'СЕЙЧАС',  color: '#dc2626' },
  { id: 'k-units',        elemId: 'k-units',        icon: I.package(),     label: 'Продано штук',  period: '30 ДНЕЙ', color: '#7c3aed' },
  { id: 'k-avg',          elemId: 'k-avg',          icon: I.receipt(),     label: 'Средний чек',   period: '30 ДНЕЙ', color: '#0891b2' },
  { id: 'k-cancels',      elemId: 'k-cancels',      icon: I.undo(),        label: 'Отмены',        period: '30 ДНЕЙ', color: '#ef4444' },
  { id: 'k-payouts',      elemId: 'k-payouts',      icon: I.wallet(),      label: 'К выплате ≈',   period: '30 ДНЕЙ', color: '#005bff' },
];

function counterDef(c: KpiCfg, title: string, description: string): WidgetDef {
  return {
    id: c.id, title, description, kind: 'counter',
    defaultDims: KPI_DEF, minDims: KPI_MIN, maxDims: KPI_MAX, icon: c.icon,
    skeleton: () => kpiSkeleton(c),
  };
}

// ── Каркас дашборд-виджета (шапка со scope + тело) ────────────────────────────

/** Шапка: цветная точка + заголовок, строка охвата, бейдж периода справа. */
function head(icon: string, title: string, scope: string, period = ''): string {
  return `<div class="cmd-widget-head">
    <div class="cmd-widget-head-l">
      <div class="cmd-widget-head-t">${icon}<span>${title}</span></div>
      <div class="cmd-widget-head-scope">${I.globe('', 11)}<span>${scope}</span></div>
    </div>
    ${period ? `<span class="cmd-widget-head-period">${period}</span>` : ''}
  </div>`;
}
function loading(text = 'Загружаем…'): string {
  return `<div class="cmd-loading-card"><span class="cmd-spinner"></span>${text}</div>`;
}

// ── Реестр ────────────────────────────────────────────────────────────────────

export const WIDGETS: Record<string, WidgetDef> = {
  // ── Счётчики ──
  'k-rev-today':    counterDef(KPIS[0], 'Выручка сегодня',   'Сумма выручки за текущий день по всем магазинам всех МП'),
  'k-rev-30':       counterDef(KPIS[1], 'Выручка 30 дней',   'Суммарная выручка за 30 дней по всем магазинам всех МП'),
  'k-orders-today': counterDef(KPIS[2], 'Заказов сегодня',   'Количество заказов за текущий день по всем МП'),
  'k-orders-30':    counterDef(KPIS[3], 'Заказов 30 дней',   'Количество заказов за 30 дней по всем МП'),
  'k-new':          counterDef(KPIS[4], 'Новые заказы',      'Заказы, ожидающие сборки прямо сейчас (все МП)'),
  'k-ship':         counterDef(KPIS[5], 'К отгрузке',        'Заказы с дедлайном отгрузки сегодня (все МП)'),
  'k-units':        counterDef(KPIS[6], 'Продано штук',      'Единиц товара продано за 30 дней (все МП)'),
  'k-avg':          counterDef(KPIS[7], 'Средний чек',       'Средняя сумма заказа за 30 дней (все МП)'),
  'k-cancels':      counterDef(KPIS[8], 'Отмены',            'Отменённые заказы за 30 дней (все МП)'),
  'k-payouts':      counterDef(KPIS[9], 'К выплате',         'Оценка к перечислению (≈85% выручки за 30 дней)'),

  // ── Дашборды ──
  'd-stores': {
    id: 'd-stores', title: 'Магазины и финансы', kind: 'dashboard',
    description: 'Карточки всех магазинов: выручка, заказы, статус подключения',
    defaultDims: { cw: 2, rh: 3 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 4 }, icon: I.store(),
    skeleton: () => head(I.store('', 15), 'Магазины и финансы', 'Все МП · по каждому магазину', '30 дней') +
      `<div class="sf-list" id="dw-stores">${loading('Подключаемся…')}</div><div class="sf-footer" id="dw-stores-footer" style="display:none"></div>`,
  },
  'd-feed': {
    id: 'd-feed', title: 'Лента заказов', kind: 'dashboard',
    description: 'Последние заказы со всех маркетплейсов в реальном времени',
    defaultDims: { cw: 2, rh: 3 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 4 }, icon: I.radio(),
    skeleton: () => head(I.radio('', 15), 'Лента заказов', SCOPE_ALL, 'live') +
      `<div class="cmd-scroll" id="dw-feed">${loading()}</div>`,
  },
  'd-urgent': {
    id: 'd-urgent', title: 'Требует действий', kind: 'dashboard',
    description: 'Заказы со срочным дедлайном отгрузки — что сделать прямо сейчас',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 1 }, maxDims: { cw: 4, rh: 4 }, icon: I.zap(),
    skeleton: () => head(I.zap('', 15), 'Требует действий', SCOPE_ALL, 'сейчас') +
      `<div class="cmd-scroll" id="dw-urgent">${loading('Проверяем…')}</div>`,
  },
  'd-rev7d': {
    id: 'd-rev7d', title: 'Выручка по дням', kind: 'dashboard',
    description: 'Столбчатый график выручки за последние 7 дней',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 3 }, icon: I.chartBar(),
    skeleton: () => head(I.chartBar('', 15), 'Выручка по дням', SCOPE_ALL, '7 дней') +
      `<div class="cmd-chart-body" id="dw-rev7d">${loading('Считаем…')}</div>`,
  },
  'd-mpshare': {
    id: 'd-mpshare', title: 'Доли маркетплейсов', kind: 'dashboard',
    description: 'Круговая диаграмма распределения выручки между Ozon, Я.Маркет и WB',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 1, rh: 2 }, maxDims: { cw: 4, rh: 3 }, icon: I.chartPie(),
    skeleton: () => head(I.chartPie('', 15), 'Доли маркетплейсов', SCOPE_MP, '30 дней') +
      `<div class="cmd-chart-body" id="dw-mpshare">${loading('Считаем доли…')}</div>`,
  },
  'd-top': {
    id: 'd-top', title: 'Топ товаров', kind: 'dashboard',
    description: 'Топ-товары по выручке за 30 дней с рейтинг-баром',
    defaultDims: { cw: 2, rh: 3 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 4 }, icon: I.trophy(),
    skeleton: () => head(I.trophy('', 15), 'Топ товаров', SCOPE_ALL, '30 дней') +
      `<div class="cmd-scroll" id="dw-top">${loading('Считаем…')}</div>`,
  },
  'd-mpcompare': {
    id: 'd-mpcompare', title: 'Сравнение маркетплейсов', kind: 'dashboard',
    description: 'Выручка и заказы по каждому маркетплейсу за 30 дней',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 1 }, maxDims: { cw: 4, rh: 3 }, icon: I.scale(),
    skeleton: () => head(I.scale('', 15), 'Сравнение МП', SCOPE_MP, '30 дней') +
      `<div class="cmd-chart-body" id="dw-mpcompare">${loading('Сравниваем…')}</div>`,
  },
  'd-hours': {
    id: 'd-hours', title: 'Заказы по часам', kind: 'dashboard',
    description: 'В какие часы суток чаще всего покупают (30 дней)',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 1 }, maxDims: { cw: 4, rh: 3 }, icon: I.clock(),
    skeleton: () => head(I.clock('', 15), 'Заказы по часам', SCOPE_ALL, '30 дней') +
      `<div class="cmd-chart-body" id="dw-hours">${loading('Считаем…')}</div>`,
  },
  'd-weekday': {
    id: 'd-weekday', title: 'Заказы по дням недели', kind: 'dashboard',
    description: 'Активность покупателей по дням недели (30 дней)',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 1 }, maxDims: { cw: 4, rh: 3 }, icon: I.calendarDays(),
    skeleton: () => head(I.calendarDays('', 15), 'Дни недели', SCOPE_ALL, '30 дней') +
      `<div class="cmd-chart-body" id="dw-weekday">${loading('Считаем…')}</div>`,
  },
  'd-status': {
    id: 'd-status', title: 'Статусы заказов', kind: 'dashboard',
    description: 'Распределение заказов по статусам: новые, к отгрузке, в работе, отменённые',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 1, rh: 2 }, maxDims: { cw: 4, rh: 3 }, icon: I.chartActivity(),
    skeleton: () => head(I.chartActivity('', 15), 'Статусы заказов', SCOPE_ALL, 'сейчас') +
      `<div class="cmd-chart-body" id="dw-status">${loading('Считаем…')}</div>`,
  },
  'd-returns': {
    id: 'd-returns', title: 'Динамика отмен', kind: 'dashboard',
    description: 'График отмен по дням за последние 14 дней',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 1 }, maxDims: { cw: 4, rh: 3 }, icon: I.undo(),
    skeleton: () => head(I.undo('', 15), 'Динамика отмен', SCOPE_ALL, '14 дней') +
      `<div class="cmd-chart-body" id="dw-returns">${loading('Считаем…')}</div>`,
  },
};

// ── Раскладка ─────────────────────────────────────────────────────────────────

export const DEFAULT_LAYOUT: string[] = [
  'k-rev-today', 'k-orders-today', 'k-new', 'k-ship',
  'd-stores', 'd-feed',
  'k-rev-30', 'k-orders-30', 'k-units', 'k-cancels',
  'd-rev7d', 'd-mpshare',
  'd-urgent', 'd-top',
  'd-hours', 'd-status',
];

const LAYOUT_KEY = 'home_widgets_layout_v3';

export function loadLayout(): string[] {
  try {
    const raw = localStorage.getItem(companyKey(LAYOUT_KEY));
    if (!raw) return [...DEFAULT_LAYOUT];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return [...DEFAULT_LAYOUT];
    const cleaned = arr.filter((id: any) => typeof id === 'string' && WIDGETS[id]);
    return cleaned.length ? cleaned : [...DEFAULT_LAYOUT];
  } catch {
    return [...DEFAULT_LAYOUT];
  }
}
export function saveLayout(ids: string[]): void {
  localStorage.setItem(companyKey(LAYOUT_KEY), JSON.stringify(ids));
}
export function resetLayout(): void {
  localStorage.removeItem(companyKey(LAYOUT_KEY));
}

// ── Рендеринг сетки ───────────────────────────────────────────────────────────

export function renderWidgetGrid(layout: string[], editMode: boolean): string {
  return layout.map((id, idx) => {
    const w = WIDGETS[id];
    if (!w) return '';
    const dims = getWidgetDims(id);
    const edit = editMode ? `
      <button class="cmd-widget-remove" onclick="window.app.removeWidget('${id}')" title="Убрать виджет" aria-label="Убрать">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>
      </button>
      <div class="cmd-widget-resize" onmousedown="window.app.onWidgetResizeStart(event,'${id}')" ontouchstart="window.app.onWidgetResizeStart(event,'${id}')" title="Потяните, чтобы изменить размер">
        <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M11 5L5 11M11 9l-2 2"/></svg>
      </div>` : '';
    const dnd = editMode
      ? `draggable="true"
         ondragstart="window.app.onWidgetDragStart(event,'${id}')"
         ondragover="window.app.onWidgetDragOver(event,this,'${id}')"
         ondragend="window.app.onWidgetDragEnd()"
         ondrop="window.app.onWidgetDrop(event,'${id}')"
         style="animation-delay:${(idx % 12) * 40}ms"`
      : '';
    return `<div class="cmd-widget cmd-widget-cw${dims.cw} cmd-widget-rh${dims.rh}${editMode ? ' editable' : ''}"
        data-widget-id="${id}" data-kind="${w.kind}" data-cw="${dims.cw}" data-rh="${dims.rh}" ${dnd}>
        ${edit}${w.skeleton()}
      </div>`;
  }).join('');
}

// ── Пикер виджетов ────────────────────────────────────────────────────────────

export function renderWidgetPicker(currentLayout: string[]): string {
  const counters = Object.values(WIDGETS).filter(w => w.kind === 'counter');
  const dashboards = Object.values(WIDGETS).filter(w => w.kind === 'dashboard');

  const card = (w: WidgetDef): string => {
    const added = currentLayout.includes(w.id);
    return `<button class="wp-card${added ? ' added' : ''}" ${added ? 'disabled' : `onclick="window.app.addWidget('${w.id}')"`}>
      <span class="wp-card-icon">${w.icon}</span>
      <span class="wp-card-body">
        <span class="wp-card-title">${w.title}</span>
        <span class="wp-card-desc">${w.description}</span>
      </span>
      <span class="wp-card-badge">${added ? '✓ добавлен' : `${w.defaultDims.cw}×${w.defaultDims.rh}`}</span>
    </button>`;
  };

  const section = (label: string, items: WidgetDef[]): string =>
    `<div class="wp-section-title">${label} · ${items.length}</div>
     <div class="wp-grid">${items.map(card).join('')}</div>`;

  return `<div class="wp-wrap">
    ${section('Счётчики', counters)}
    ${section('Дашборды', dashboards)}
  </div>`;
}
