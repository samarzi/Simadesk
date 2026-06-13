/**
 * HomeWidgets — реестр виджетов главной страницы.
 *
 * Каждый виджет:
 *   - имеет уникальный id, заголовок, размер (s/m/l), иконку
 *   - рендерит свой HTML-скелет с фиксированными внутренними id
 *   - заполняется через App.populateLiveCommandCenter (по тем же id)
 *
 * Раскладка пользователя хранится в localStorage по ключу `home_widgets_layout_v1`.
 */

export type WidgetSize = 's' | 'm' | 'l';
export type ColSpan = 1 | 2 | 3 | 4;
export type RowSpan = 1 | 2 | 3 | 4;
export interface WidgetDims { cw: ColSpan; rh: RowSpan }

export interface WidgetDef {
  id: string;
  title: string;
  description: string;
  size: WidgetSize;             // legacy (для миграции)
  defaultDims: WidgetDims;      // дефолтный размер cw×rh
  minDims: WidgetDims;          // минимальный размер
  maxDims: WidgetDims;          // максимальный размер
  icon: string;
  skeleton(): string;
  preview(): string;
}

const DIMS_KEY = 'home_widgets_dims_v1';
function getCompanyDimsKey(): string {
  const cid = localStorage.getItem('active_company_id');
  return cid ? `${DIMS_KEY}_${cid}` : DIMS_KEY;
}
export function loadDims(): Record<string, WidgetDims> {
  try { return JSON.parse(localStorage.getItem(getCompanyDimsKey()) || '{}'); } catch { return {}; }
}
export function saveDims(dims: Record<string, WidgetDims>): void {
  localStorage.setItem(getCompanyDimsKey(), JSON.stringify(dims));
}
export function resetDims(): void {
  localStorage.removeItem(getCompanyDimsKey());
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
  const clampedCw = Math.max(w.minDims.cw, Math.min(w.maxDims.cw, Math.round(cw))) as ColSpan;
  const clampedRh = Math.max(w.minDims.rh, Math.min(w.maxDims.rh, Math.round(rh))) as RowSpan;
  return { cw: clampedCw, rh: clampedRh };
}

// ── Реестр виджетов ──────────────────────────────────────────────────────────

/**
 * KPI виджет — новый адаптивный layout:
 *  Top:    [icon]                    [period badge]
 *  Mid:    VALUE
 *          label · subtitle
 *  Bottom: ↑ +12%  (trend, только 1×2 и больше)
 *          sparkline ▁▂▄▆█ (только 2×2 и больше)
 */
const kpiWidget = (
  _id: string, elemId: string, icon: string, label: string, period: string, color: string,
  previewVal = '12 450 ₽', previewSpark = [3,5,4,7,6,8,9],
): { skeleton(): string; preview(): string } => ({
  skeleton() {
    return `<div class="cmd-kpi" id="${elemId}" style="--kpi-color:${color}">
      <div class="cmd-kpi-top">
        <div class="cmd-kpi-icon">${icon}</div>
        <div class="cmd-kpi-period">${period}</div>
      </div>
      <div class="cmd-kpi-main">
        <div class="cmd-kpi-val">0</div>
        <div class="cmd-kpi-label">${label}</div>
        <div class="cmd-kpi-trend" id="${elemId}-trend" style="display:none"></div>
      </div>
      <div class="cmd-kpi-spark" id="${elemId}-spark"></div>
    </div>`;
  },
  preview() {
    const max = Math.max(...previewSpark);
    return `<div class="cmd-kpi" style="--kpi-color:${color}">
      <div class="cmd-kpi-top">
        <div class="cmd-kpi-icon">${icon}</div>
        <div class="cmd-kpi-period">${period}</div>
      </div>
      <div class="cmd-kpi-main">
        <div class="cmd-kpi-val">${previewVal}</div>
        <div class="cmd-kpi-label">${label}</div>
        <div class="cmd-kpi-trend up">↑ +12%</div>
      </div>
      <div class="cmd-kpi-spark">
        ${previewSpark.map(v => `<div style="height:${Math.max(15, v/max*100)}%"></div>`).join('')}
      </div>
    </div>`;
  },
});

// Стандартные размеры в формате cw×rh
const KPI_S: WidgetDims = { cw: 1, rh: 1 };
const KPI_MIN: WidgetDims = { cw: 1, rh: 1 };
const KPI_MAX: WidgetDims = { cw: 2, rh: 2 };

export const WIDGETS: Record<string, WidgetDef> = {
  'kpi-today': {
    id: 'kpi-today', title: 'Выручка сегодня',
    description: 'Сумма выручки за текущий день по всем магазинам',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '💰',
    ...kpiWidget('kpi-today','cmd-kpi-today','💰','Выручка','СЕГОДНЯ','#16a34a','17 232 ₽',[2,4,3,5,7,8,9]),
  },
  'kpi-new': {
    id: 'kpi-new', title: 'Новые заказы',
    description: 'Количество новых заказов, требующих сборки прямо сейчас',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '🆕',
    ...kpiWidget('kpi-new','cmd-kpi-new','🆕','Новые заказы','НА СБОРКЕ','#ea580c','7',[1,2,4,3,5,7,8]),
  },
  'kpi-ship': {
    id: 'kpi-ship', title: 'К отгрузке',
    description: 'Заказы с дедлайном отгрузки до конца текущих суток',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '📦',
    ...kpiWidget('kpi-ship','cmd-kpi-ship','📦','К отгрузке','ДО 23:59','#dc2626','3',[5,4,6,5,3,4,3]),
  },
  'kpi-payouts': {
    id: 'kpi-payouts', title: 'Ожидает выплат',
    description: 'Примерная сумма к перечислению (≈85% от выручки за 30 дней)',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '💼',
    ...kpiWidget('kpi-payouts','cmd-kpi-payouts','💼','Ожидает выплат','30 ДНЕЙ','#005bff','32 064 ₽',[3,4,5,6,7,8,9]),
  },
  'kpi-units-30': {
    id: 'kpi-units-30', title: 'Продано штук',
    description: 'Общее количество единиц товара, проданных за 30 дней',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '🛒',
    ...kpiWidget('kpi-units-30','cmd-kpi-units30','🛒','Продано штук','30 ДНЕЙ','#7c3aed','248',[5,7,6,8,10,9,11]),
  },
  'kpi-avg-check': {
    id: 'kpi-avg-check', title: 'Средний чек',
    description: 'Средняя сумма одного заказа за 30 дней',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '🧾',
    ...kpiWidget('kpi-avg-check','cmd-kpi-avgcheck','🧾','Средний чек','30 ДНЕЙ','#0891b2','3 142 ₽',[2,3,4,3,4,5,4]),
  },
  'kpi-revenue-30': {
    id: 'kpi-revenue-30', title: 'Выручка',
    description: 'Суммарная выручка за последние 30 дней по всем маркетплейсам',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '📊',
    ...kpiWidget('kpi-revenue-30','cmd-kpi-rev30','📊','Выручка','30 ДНЕЙ','#16a34a','287 432 ₽',[3,5,4,6,7,9,11]),
  },
  'kpi-orders-30': {
    id: 'kpi-orders-30', title: 'Количество заказов',
    description: 'Количество заказов за 30 дней по всем маркетплейсам',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '🛍️',
    ...kpiWidget('kpi-orders-30','cmd-kpi-ord30','🛍️','Заказов','30 ДНЕЙ','#f59e0b','91',[2,3,4,5,4,5,6]),
  },
  'kpi-returns': {
    id: 'kpi-returns', title: 'Отмены / Возвраты',
    description: 'Количество отменённых и возвращённых заказов за 30 дней',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '↩️',
    ...kpiWidget('kpi-returns','cmd-kpi-returns','↩️','Отмены','30 ДНЕЙ','#ef4444','12',[3,4,3,2,3,2,2]),
  },
  'kpi-rating': {
    id: 'kpi-rating', title: 'Средняя оценка',
    description: 'Средний рейтинг товаров по всем подключённым магазинам',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '⭐',
    ...kpiWidget('kpi-rating','cmd-kpi-rating','⭐','Рейтинг','ВСЕ МП','#f59e0b','4.7',[4,4,5,4,5,5,5]),
  },
  'stores-grid': {
    id: 'stores-grid', title: 'Магазины и финансы',
    description: 'Карточки всех подключённых магазинов с выручкой и заказами',
    size: 'l',
    defaultDims: { cw: 4, rh: 3 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 4 },
    icon: '🏪',
    skeleton() {
      return `
        <div class="cmd-widget-head">
          <span>🏪 Магазины и финансы</span>
          <span class="sf-period">30 дней</span>
        </div>
        <div class="sf-list" id="cmd-stores-grid">
          <div class="sf-loading">Подключаемся…</div>
        </div>
        <div class="sf-footer" id="sf-footer" style="display:none"></div>
      `;
    },
    preview() {
      const rows = [['My Ozon','#005bff','OZON','87 450','12'],['Яндекс FBS','#fc3f1d','ЯМ','42 100','8'],
                    ['WB основной','#cb11ab','WB','124 300','31'],['WB FBO','#cb11ab','WB','34 000','9']];
      return `
        <div class="cmd-widget-head"><span>🏪 Магазины и финансы</span><span class="sf-period">30 дней</span></div>
        <div class="sf-list">
          ${rows.map(([n,c,mp,r,o])=>`
            <div class="sf-row" style="--c:${c}">
              <span class="sf-dot"></span>
              <span class="sf-name">${n}</span>
              <span class="sf-mp">${mp}</span>
              <span class="sf-rev">${r} ₽</span>
              <span class="sf-orders">${o} зак.</span>
              <span class="sf-tags"></span>
              <span class="sf-status live"></span>
            </div>`).join('')}
        </div>
        <div class="sf-footer">
          <span class="sf-footer-label">Итого 30 дн.</span>
          <span class="sf-footer-rev">287 850 ₽</span>
          <span class="sf-footer-ord">60 зак.</span>
        </div>`;
    },
  },
  'live-feed': {
    id: 'live-feed', title: 'Лента заказов',
    description: 'Последние 12 заказов в реальном времени',
    size: 'm',
    defaultDims: { cw: 2, rh: 3 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 4 },
    icon: '📡',
    skeleton() {
      return `<div class="cmd-widget-head"><span>📡 Live-лента заказов</span>
        <span class="cmd-live-dot"></span></div>
        <div id="cmd-live-feed"><div class="cmd-loading-card">Загружаем заказы…</div></div>`;
    },
    preview() {
      const items = [['только что','Кеды мужские кожаные','3 077 ₽'],
        ['2 мин','Туфли классические','5 200 ₽'],['8 мин','Мокасины замшевые','4 100 ₽']];
      return `<div class="cmd-widget-head"><span>📡 Live-лента</span><span class="cmd-live-dot"></span></div>
        <div style="padding:6px 0">${items.map(([t,n,p]) =>
          `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-bottom:1px solid var(--border)">
            <div><div style="font-size:12px;font-weight:500">${n}</div>
              <div style="font-size:10px;color:var(--text-2)">${t}</div></div>
            <div style="font-size:13px;font-weight:700;color:#16a34a">${p}</div>
          </div>`).join('')}</div>`;
    },
  },
  'urgent-actions': {
    id: 'urgent-actions', title: 'Требует действий',
    description: 'Заказы со срочным дедлайном отгрузки',
    size: 'm',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 1 }, maxDims: { cw: 4, rh: 4 },
    icon: '⚡',
    skeleton() {
      return `<div class="cmd-widget-head"><span>⚡ Требует действий</span></div>
        <div id="cmd-actions-list"><div class="cmd-loading-card">Проверяем…</div></div>`;
    },
    preview() {
      return `<div class="cmd-widget-head"><span>⚡ Требует действий</span></div>
        <div style="padding:8px 14px;display:flex;flex-direction:column;gap:6px">
          <div style="padding:8px 12px;background:#dc262610;border-left:3px solid #dc2626;border-radius:6px;font-size:12px">
            🔴 3 заказа — отгрузка сегодня до 18:00</div>
          <div style="padding:8px 12px;background:#f59e0b10;border-left:3px solid #f59e0b;border-radius:6px;font-size:12px">
            🟡 2 заказа — отгрузка завтра</div>
        </div>`;
    },
  },
  'mp-share': {
    id: 'mp-share', title: 'Доли маркетплейсов',
    description: 'Распределение выручки между Ozon, Я.Маркет и WB',
    size: 'm',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 1 }, maxDims: { cw: 4, rh: 3 },
    icon: '🥧',
    skeleton() {
      return `<div class="cmd-widget-head"><span>🥧 Доли маркетплейсов</span>
        <span style="font-size:11px;color:var(--text3);font-weight:400">30 дней</span></div>
        <div id="cmd-mp-share"><div class="cmd-loading-card">Считаем доли…</div></div>`;
    },
    preview() {
      return `<div class="cmd-widget-head"><span>🥧 Доли маркетплейсов</span></div>
        <div style="padding:12px 14px;display:flex;flex-direction:column;gap:6px">
          ${[['WB','#cb11ab',52],['Ozon','#005bff',31],['Яндекс','#fc3f1d',17]]
            .map(([n,c,p]) => `<div>
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
                <span style="color:${c};font-weight:600">${n}</span><span>${p}%</span></div>
              <div style="height:5px;border-radius:3px;background:var(--border)">
                <div style="width:${p}%;height:100%;border-radius:3px;background:${c}"></div></div>
            </div>`).join('')}
        </div>`;
    },
  },
  'revenue-7d': {
    id: 'revenue-7d', title: 'Выручка по дням (7д)',
    description: 'График выручки за последние 7 дней',
    size: 'm',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 3 },
    icon: '📈',
    skeleton() {
      return `<div class="cmd-widget-head"><span>📈 Выручка по дням</span>
        <span style="font-size:11px;color:var(--text3);font-weight:400">7 дней</span></div>
        <div id="cmd-revenue-7d" style="padding:10px 12px 14px"><div class="cmd-loading-card">Считаем…</div></div>`;
    },
    preview() {
      const days = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
      const vals = [42,67,55,80,73,95,88];
      const max = Math.max(...vals);
      return `<div class="cmd-widget-head"><span>📈 Выручка 7 дней</span></div>
        <div style="padding:10px 14px 14px;display:flex;align-items:flex-end;gap:6px;height:90px">
          ${days.map((d,i) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
            <div style="flex:1;width:100%;background:#16a34a;border-radius:3px 3px 0 0;min-height:4px"
              data-h="${Math.round(vals[i]/max*60)}px" style="height:${Math.round(vals[i]/max*60)}px"></div>
            <div style="font-size:9px;color:var(--text-2)">${d}</div>
          </div>`).join('')}
        </div>`;
    },
  },
  'top-products': {
    id: 'top-products', title: 'Топ товаров (30д)',
    description: 'Топ-5 товаров по выручке за 30 дней',
    size: 'm',
    defaultDims: { cw: 2, rh: 3 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 4 },
    icon: '🏆',
    skeleton() {
      return `<div class="cmd-widget-head"><span>🏆 Топ товаров</span>
        <span style="font-size:11px;color:var(--text3);font-weight:400">30 дней</span></div>
        <div id="cmd-top-products"><div class="cmd-loading-card">Считаем…</div></div>`;
    },
    preview() {
      const products = [['Кеды мужские кожаные','45 200 ₽','18'],['Туфли классические','38 100 ₽','12'],
        ['Мокасины замшевые','22 500 ₽','9']];
      return `<div class="cmd-widget-head"><span>🏆 Топ товаров</span></div>
        <div>${products.map(([n,r,q],i) =>
          `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--border)">
            <div style="width:18px;height:18px;border-radius:50%;background:#f59e0b20;color:#f59e0b;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center">${i+1}</div>
            <div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n}</div>
              <div style="font-size:10px;color:var(--text-2)">${q} шт.</div></div>
            <div style="font-size:12px;font-weight:700;color:#16a34a">${r}</div>
          </div>`).join('')}</div>`;
    },
  },
  'stock-alert': {
    id: 'stock-alert', title: 'Критичные остатки',
    description: 'Товары, которые заканчиваются (запас < 5 дней)',
    size: 'm',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 1 }, maxDims: { cw: 4, rh: 4 },
    icon: '⚠️',
    skeleton() {
      return `<div class="cmd-widget-head"><span>⚠️ Критичные остатки</span></div>
        <div id="cmd-stock-alert"><div class="cmd-loading-card">Проверяем остатки…</div></div>`;
    },
    preview() {
      const items = [['Кеды черные 40р','2 шт'],['Туфли корич. 43р','0 шт'],['Мокасины 42р','3 шт']];
      return `<div class="cmd-widget-head"><span>⚠️ Критичные остатки</span></div>
        <div>${items.map(([n,s]) =>
          `<div style="display:flex;justify-content:space-between;padding:7px 14px;border-bottom:1px solid var(--border)">
            <div style="font-size:12px">${n}</div>
            <div style="font-size:12px;font-weight:700;color:${s==='0 шт'?'#dc2626':'#f59e0b'}">${s}</div>
          </div>`).join('')}</div>`;
    },
  },
  'kpi-cancels': {
    id: 'kpi-cancels', title: 'Отмены / Возвраты',
    description: 'Количество отменённых и возвращённых заказов за 30 дней',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '↩️',
    ...kpiWidget('kpi-cancels','cmd-kpi-cancels','↩️','Отмены/Возвраты','30 ДНЕЙ','#ef4444','5',[3,2,4,2,3,1,2]),
  },
  'kpi-stock-total': {
    id: 'kpi-stock-total', title: 'Остаток товаров',
    description: 'Общее количество товаров на складе по всем магазинам',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '🏭',
    ...kpiWidget('kpi-stock-total','cmd-kpi-stocktotal','🏭','Остаток (склад)','СЕЙЧАС','#0891b2','1 248',[8,9,7,8,6,7,8]),
  },
  'kpi-reviews-new': {
    id: 'kpi-reviews-new', title: 'Новые отзывы',
    description: 'Отзывы без ответа за последние 7 дней',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '💬',
    ...kpiWidget('kpi-reviews-new','cmd-kpi-reviewsnew','💬','Без ответа','7 ДНЕЙ','#7c3aed','3',[1,2,1,3,2,1,3]),
  },
  'kpi-revenue-today': {
    id: 'kpi-revenue-today', title: 'Выручка за сегодня',
    description: 'Общая выручка за текущий день',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '📅',
    ...kpiWidget('kpi-revenue-today','cmd-kpi-revtoday','📅','Выручка сегодня','СЕГОДНЯ','#16a34a','8 400 ₽',[3,5,4,6,5,7,8]),
  },
  'kpi-margin': {
    id: 'kpi-margin', title: 'Средняя маржа',
    description: 'Средняя маржинальность по товарам со стоимостью',
    size: 's', defaultDims: KPI_S, minDims: KPI_MIN, maxDims: KPI_MAX, icon: '📐',
    ...kpiWidget('kpi-margin','cmd-kpi-margin','📐','Средняя маржа','30 ДНЕЙ','#059669','42%',[4,5,4,6,5,6,7]),
  },
  'reviews-feed': {
    id: 'reviews-feed', title: 'Последние отзывы',
    description: 'Список последних отзывов покупателей по всем маркетплейсам',
    size: 'm',
    defaultDims: { cw: 2, rh: 3 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 4 },
    icon: '💬',
    skeleton() {
      return `<div class="cmd-widget-head"><span>💬 Последние отзывы</span>
        <span class="cmd-live-dot"></span></div>
        <div id="cmd-reviews-feed"><div class="cmd-loading-card">Загружаем отзывы…</div></div>`;
    },
    preview() {
      const items = [['⭐⭐⭐⭐⭐','Отличный товар!','WB'],['⭐⭐⭐','Долгая доставка','Ozon'],['⭐⭐⭐⭐⭐','Рекомендую','ЯМ']];
      return `<div class="cmd-widget-head"><span>💬 Отзывы</span></div>
        <div>${items.map(([stars,text,mp]) =>
          `<div style="padding:8px 14px;border-bottom:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;margin-bottom:2px">
              <span style="font-size:11px">${stars}</span>
              <span style="font-size:9px;color:var(--text-2)">${mp}</span>
            </div>
            <div style="font-size:12px;color:var(--text)">${text}</div>
          </div>`).join('')}</div>`;
    },
  },
  'returns-dynamics': {
    id: 'returns-dynamics', title: 'Динамика возвратов',
    description: 'График количества возвратов по дням за 30 дней',
    size: 'm',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 3 },
    icon: '↩️',
    skeleton() {
      return `<div class="cmd-widget-head"><span>↩️ Динамика возвратов</span>
        <span style="font-size:11px;color:var(--text3);font-weight:400">30 дней</span></div>
        <div id="cmd-returns-dynamics" style="padding:10px 12px 14px"><div class="cmd-loading-card">Считаем…</div></div>`;
    },
    preview() {
      const vals = [1,0,2,1,3,1,0,2,1,2,3,1,0,1,2];
      const max = Math.max(...vals, 1);
      return `<div class="cmd-widget-head"><span>↩️ Возвраты</span></div>
        <div style="padding:10px 14px;display:flex;align-items:flex-end;gap:3px;height:80px">
          ${vals.map(v => `<div style="flex:1;background:${v>2?'#dc2626':v>0?'#f59e0b':'var(--bg-2)'};border-radius:2px 2px 0 0;height:${Math.max(4,v/max*60)}px"></div>`).join('')}
        </div>`;
    },
  },
  'mp-orders-compare': {
    id: 'mp-orders-compare', title: 'Сравнение маркетплейсов',
    description: 'Сравнение заказов и выручки по каждому маркетплейсу за 30 дней',
    size: 'm',
    defaultDims: { cw: 2, rh: 2 }, minDims: { cw: 2, rh: 2 }, maxDims: { cw: 4, rh: 3 },
    icon: '⚖️',
    skeleton() {
      return `<div class="cmd-widget-head"><span>⚖️ Сравнение МП</span>
        <span style="font-size:11px;color:var(--text3);font-weight:400">30 дней</span></div>
        <div id="cmd-mp-compare"><div class="cmd-loading-card">Сравниваем…</div></div>`;
    },
    preview() {
      return `<div class="cmd-widget-head"><span>⚖️ Сравнение МП</span></div>
        <div style="padding:10px 14px;display:flex;flex-direction:column;gap:8px">
          ${[['WB','#cb11ab','124 300 ₽','31 зак.'],['Ozon','#005bff','87 450 ₽','12 зак.'],['ЯМ','#fc3f1d','42 100 ₽','8 зак.']]
            .map(([n,c,r,o]) => `
              <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:11px;font-weight:700;color:${c};width:40px">${n}</span>
                <div style="flex:1;height:8px;border-radius:4px;background:var(--bg-2)">
                  <div style="height:100%;border-radius:4px;background:${c};width:${n==='WB'?75:n==='Ozon'?53:26}%"></div>
                </div>
                <span style="font-size:11px;font-weight:600;width:70px;text-align:right">${r}</span>
                <span style="font-size:10px;color:var(--text-2);width:42px">${o}</span>
              </div>`).join('')}
        </div>`;
    },
  },
};

// ── Раскладка ────────────────────────────────────────────────────────────────

export const DEFAULT_LAYOUT: string[] = [
  'kpi-today', 'kpi-new', 'kpi-ship', 'kpi-payouts',
  'kpi-units-30', 'kpi-avg-check', 'kpi-returns', 'kpi-rating',
  'stores-grid',
  'live-feed', 'urgent-actions',
  'mp-share',
];

const LAYOUT_KEY = 'home_widgets_layout_v1';

function getCompanyLayoutKey(): string {
  const cid = localStorage.getItem('active_company_id');
  return cid ? `${LAYOUT_KEY}_${cid}` : LAYOUT_KEY;
}

export function loadLayout(): string[] {
  try {
    const key = getCompanyLayoutKey();
    const raw = localStorage.getItem(key);
    if (!raw) return [...DEFAULT_LAYOUT];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return [...DEFAULT_LAYOUT];
    return arr.filter((id: any) => typeof id === 'string' && WIDGETS[id]);
  } catch {
    return [...DEFAULT_LAYOUT];
  }
}

export function saveLayout(ids: string[]): void {
  localStorage.setItem(getCompanyLayoutKey(), JSON.stringify(ids));
}

export function resetLayout(): void {
  localStorage.removeItem(getCompanyLayoutKey());
}

// ── Рендеринг сетки ──────────────────────────────────────────────────────────

export function renderWidgetGrid(layout: string[], editMode: boolean): string {
  return layout.map((id, idx) => {
    const w = WIDGETS[id];
    if (!w) return '';
    const dims = getWidgetDims(id);
    const editControls = editMode ? `
      <div class="cmd-widget-edit-controls">
        <button class="cmd-widget-ctrl cmd-widget-ctrl-remove" onclick="window.app.removeWidget('${id}')" title="Убрать">✕</button>
      </div>
    ` : '';
    const resizeHandle = editMode ? `
      <div class="cmd-widget-resize" onmousedown="window.app.onWidgetResizeStart(event,'${id}')"
        ontouchstart="window.app.onWidgetResizeStart(event,'${id}')" title="Перетащите для изменения размера">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M2 10L10 2M6 10L10 6"/>
        </svg>
      </div>` : '';
    const dragAttrs = editMode
      ? `draggable="true"
         ondragstart="window.app.onWidgetDragStart(event,'${id}')"
         ondragover="window.app.onWidgetDragOver(event,this,'${id}')"
         ondragleave="window.app.onWidgetDragLeave(this)"
         ondragend="window.app.onWidgetDragEnd()"
         ondrop="window.app.onWidgetDrop(event,'${id}')"
         style="animation-delay:${idx * 50}ms"`
      : '';
    return `
      <div class="cmd-widget cmd-widget-cw${dims.cw} cmd-widget-rh${dims.rh}${editMode ? ' wobble' : ''}"
        data-widget-id="${id}" data-cw="${dims.cw}" data-rh="${dims.rh}" ${dragAttrs}>
        ${editControls}
        ${resizeHandle}
        ${w.skeleton()}
      </div>
    `;
  }).join('');
}

export function renderWidgetPicker(currentLayout: string[]): string {
  const available = Object.values(WIDGETS).filter(w => !currentLayout.includes(w.id));
  const added = Object.values(WIDGETS).filter(w => currentLayout.includes(w.id));

  if (available.length === 0) {
    return `<div style="padding:40px;text-align:center;color:var(--muted);font-size:13px">
      <div style="font-size:32px;margin-bottom:12px">✅</div>
      <div style="font-weight:600;font-size:15px;margin-bottom:6px">Все виджеты добавлены</div>
      <div style="font-size:12px">Уберите ненужные нажав ✕ на виджете</div>
    </div>`;
  }

  // Лёгкие карточки без рендера превью (тяжёлые превью вызывали лаг)
  const card = (w: WidgetDef, isAdded: boolean) => `
    <div onclick="${isAdded ? '' : `window.app.addWidget('${w.id}')`}"
      style="background:var(--bg);border:2px solid ${isAdded?'#16a34a':'var(--border)'};border-radius:12px;
        padding:14px 16px;cursor:${isAdded?'default':'pointer'};
        display:flex;align-items:center;gap:12px;${isAdded?'opacity:.55':''}
        transition:border-color .15s,box-shadow .15s;"
      ${isAdded?'':` onmouseover="this.style.borderColor='var(--accent)';this.style.boxShadow='0 3px 12px rgba(0,0,0,.1)'"
        onmouseout="this.style.borderColor='var(--border)';this.style.boxShadow='none'"`}>
      <div style="width:44px;height:44px;border-radius:10px;background:var(--bg2);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">${w.icon}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;color:var(--text)">${w.title}</div>
        <div style="font-size:11px;color:var(--text-2);margin-top:2px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${w.description}</div>
      </div>
      <div style="flex-shrink:0">
        ${isAdded
          ? `<span style="font-size:10px;font-weight:700;color:#16a34a;background:#dcfce7;padding:3px 9px;border-radius:10px">✓ На дашборде</span>`
          : `<span style="font-size:11px;font-weight:700;color:var(--text-2);background:var(--bg2);padding:3px 9px;border-radius:10px">${w.defaultDims.cw}×${w.defaultDims.rh}</span>`}
      </div>
    </div>
  `;

  return `
    <div style="padding:4px 0 8px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);padding:0 2px 10px">
        Доступные (${available.length})
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${available.map(w => card(w, false)).join('')}
      </div>
      ${added.length > 0 ? `
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);padding:18px 2px 10px">
          Уже добавлены (${added.length})
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${added.map(w => card(w, true)).join('')}
        </div>
      ` : ''}
    </div>
  `;
}
