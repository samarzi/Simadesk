/**
 * MetricTip — единая система подсказок для метрик аналитики.
 *
 * Каждая метрика получает кнопку «?» которая открывает попап с:
 *   - Описанием (что это за метрика, что считается, что НЕ считается)
 *   - Формулой (точная формула расчёта)
 *   - Источником (откуда берутся входные данные)
 *   - Бейджем «Реальные данные» / «Прикидка» / «От пользователя»
 *
 * Использование:
 *   const tipHtml = renderMetricTipButton({
 *     id: 'kpi-revenue',
 *     title: 'Выручка',
 *     what: 'Сумма всех заказов кроме отменённых...',
 *     formula: 'sum(price × quantity) по всем строкам заказов',
 *     source: 'API маркетплейсов: Ozon /v3/posting/fbs/list, ...',
 *     dataKind: 'real',
 *     notes: ['Включает заказы которые ещё не доставлены покупателю']
 *   });
 */

export type MetricDataKind = 'real' | 'approx' | 'user_input' | 'mixed';

export interface MetricTipMeta {
  id: string;
  title: string;
  /** Что эта метрика означает простыми словами. */
  what: string;
  /** Точная формула расчёта (текст или HTML). */
  formula: string;
  /** Откуда берутся входные данные (API эндпоинт или поле). */
  source: string;
  /** Тип данных. */
  dataKind: MetricDataKind;
  /** Доп. заметки/предупреждения (показываются как bullet-list). */
  notes?: string[];
}

const STORE = new Map<string, MetricTipMeta>();

export function registerMetricTip(meta: MetricTipMeta): void {
  STORE.set(meta.id, meta);
}

export function renderMetricTipButton(meta: MetricTipMeta): string {
  STORE.set(meta.id, meta);
  return `<button type="button" class="metric-tip-btn" onclick="window.__showMetricTip?.('${meta.id}')" title="Как считается эта метрика" aria-label="Подробнее">?</button>`;
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function badgeFor(k: MetricDataKind): { label: string; color: string; descr: string } {
  switch (k) {
    case 'real':       return { label: 'Реальные данные',  color: '#16a34a', descr: 'Цифра берётся напрямую из API маркетплейса.' };
    case 'approx':     return { label: 'Прикидка',          color: '#f59e0b', descr: 'Считается по фиксированной ставке из настроек, а не из реальных финотчётов МП. Реальная цифра может отличаться.' };
    case 'user_input': return { label: 'Введено вручную',   color: '#0891b2', descr: 'Зависит от данных, которые ты сам(а) ввёл(а).' };
    case 'mixed':      return { label: 'Смешанный расчёт', color: '#7c3aed', descr: 'Часть значений — из API, часть — прикидка по настройкам.' };
  }
}

function buildTipHtml(m: MetricTipMeta): string {
  const b = badgeFor(m.dataKind);
  const notes = m.notes?.length
    ? `<div class="metric-tip-section"><div class="metric-tip-section-title">Важно знать</div><ul>${m.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`
    : '';
  return `
    <div class="metric-tip-modal-content">
      <div class="metric-tip-head">
        <div class="metric-tip-title">${escapeHtml(m.title)}</div>
        <span class="metric-tip-badge" style="background:${b.color}22;color:${b.color};border-color:${b.color}55" title="${escapeHtml(b.descr)}">${b.label}</span>
      </div>

      <div class="metric-tip-section">
        <div class="metric-tip-section-title">Что это</div>
        <div class="metric-tip-text">${escapeHtml(m.what)}</div>
      </div>

      <div class="metric-tip-section">
        <div class="metric-tip-section-title">Как считается</div>
        <div class="metric-tip-formula">${m.formula}</div>
      </div>

      <div class="metric-tip-section">
        <div class="metric-tip-section-title">Источник данных</div>
        <div class="metric-tip-text">${m.source}</div>
      </div>

      ${notes}

      <div class="metric-tip-section metric-tip-kind">
        <div class="metric-tip-section-title">Тип данных</div>
        <div class="metric-tip-text" style="color:${b.color}"><b>${b.label}.</b> ${escapeHtml(b.descr)}</div>
      </div>
    </div>
  `;
}

function ensureModalHost(): HTMLElement {
  let host = document.getElementById('metric-tip-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'metric-tip-host';
  host.className = 'metric-tip-host';
  host.style.display = 'none';
  host.innerHTML = `
    <div class="metric-tip-backdrop" data-tip-close="1"></div>
    <div class="metric-tip-modal" role="dialog" aria-modal="true">
      <button type="button" class="metric-tip-close" data-tip-close="1" aria-label="Закрыть">✕</button>
      <div class="metric-tip-body"></div>
    </div>
  `;
  document.body.appendChild(host);
  host.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.tipClose === '1') {
      host!.style.display = 'none';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && host!.style.display !== 'none') host!.style.display = 'none';
  });
  return host;
}

function showMetricTip(id: string): void {
  const meta = STORE.get(id);
  if (!meta) {
    console.warn('[metricTip] unknown id:', id);
    return;
  }
  const host = ensureModalHost();
  const body = host.querySelector<HTMLElement>('.metric-tip-body');
  if (body) body.innerHTML = buildTipHtml(meta);
  host.style.display = 'flex';
}

// Expose globally for inline onclick
window.__showMetricTip = showMetricTip;
