/**
 * Вкладка «Юнит-экономика»: прогноз прибыли по заказам периода.
 */

import { MP_SHORT, MP_COLOR } from '../types';
import { UnitEconResult, UnitEconSettings, UnitSkuRow } from '../services/unitEconomics';
import { fmtFull, fmtRub2, fmtNum, fmtQty, fmtPct, escapeHtml } from '../components/format';
import { renderKpiCard } from '../components/KpiCard';
import { Sheet } from '../services/exporter';

export type UnitSortKey = 'orderedRevenue' | 'orderedUnits' | 'buyoutPct' | 'profit' | 'profitPerUnit' | 'roi' | 'drrBought' | 'ads';

export interface UnitTabState {
  result: UnitEconResult | null;
  loading: boolean;
  error: string;
  settings: UnitEconSettings;
  periodLabel: string;
  updatedAt: Date | null;
  sort: { key: UnitSortKey; dir: 1 | -1 };
  perfConnected: boolean;
  isOzon: boolean;
  /** Опорное окно истории, для подписи. */
  historyLabel: string;
}

const M = 'window.analyticsModule';

const BASIS_HINT: Record<string, string> = {
  sku: 'по истории этого товара',
  store: 'среднее по магазину — у товара мало истории',
  none: 'нет истории — из настроек',
  manual: 'задан вручную',
};

function pctPair(a: number, b: number): string {
  return `${fmtPct(a, 2)} / ${fmtPct(b, 2)}`;
}

export function renderUnitTab(s: UnitTabState): string {
  const toolbar = renderToolbar(s);
  if (s.error) return `${toolbar}<div class="an2-data-message error">${escapeHtml(s.error)}</div>`;
  if (!s.result) {
    return `${toolbar}
      <div class="an2-loader"><div class="an2-loader-ring"></div>
        <div class="an2-loader-text">Считаем юнит-экономику: история выкупа, удержания, реклама…</div></div>`;
  }
  const r = s.result;
  if (!r.orders) {
    return `${toolbar}<div class="an2-empty"><h3>За период нет заказов</h3><p>Выберите другой период или магазин.</p></div>`;
  }
  return `
    ${toolbar}
    ${renderKpis(r)}
    <div class="an2-unit-grid">
      ${renderCosts(r)}
      ${renderAds(r, s)}
    </div>
    <div class="an2-unit-grid">
      ${renderScenario(r, s.settings)}
      ${renderFacts(r)}
    </div>
    ${renderSkuTable(r, s.sort)}
    ${renderNuances(r)}
  `;
}

function renderToolbar(s: UnitTabState): string {
  const st = s.settings;
  const updated = s.updatedAt
    ? s.updatedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) + ' МСК'
    : '—';
  return `
    <div class="an2-card an2-unit-toolbar">
      <div class="an2-unit-title">
        <div>
          <div class="an2-card-title">Юнит-экономика · ${escapeHtml(s.periodLabel)}</div>
          <div class="an2-unit-sub">
            Обновлено ${updated}${s.loading ? ' · <span class="an2-mini-spinner"></span> пересчёт…' : ''}
            · ставки и выкуп — из финотчётов ${escapeHtml(s.historyLabel)}
          </div>
        </div>
        <div class="an2-unit-actions">
          <button class="an2-btn ghost" onclick="${M}?.copyUnitReport(this)" title="Текстовый отчёт — удобно отправить в чат">Скопировать отчёт</button>
          <button class="an2-btn ghost" onclick="${M}?.exportUnit('xlsx')">Excel</button>
          <button class="an2-btn ghost" onclick="${M}?.exportUnit('json')">JSON</button>
        </div>
      </div>
      <div class="an2-unit-controls">
        <label class="an2-unit-ctl">
          <span>Ожидаемый выкуп</span>
          <select onchange="${M}?.setUnitSetting('buyoutMode', this.value)">
            <option value="auto" ${st.buyoutMode === 'auto' ? 'selected' : ''}>Авто — по истории</option>
            <option value="manual" ${st.buyoutMode === 'manual' ? 'selected' : ''}>Вручную</option>
          </select>
          <input type="number" min="1" max="100" step="1" value="${st.buyoutPct}"
            title="${st.buyoutMode === 'manual' ? 'Процент выкупа для всех товаров' : 'Запасной процент для товаров без истории'}"
            onchange="${M}?.setUnitSetting('buyoutPct', this.value)"/><span>%</span>
        </label>
        <label class="an2-unit-ctl">
          <span>Сценарий: себестоимость</span>
          <input type="number" min="0" step="1" placeholder="₽ за шт" value="${st.scenarioCost ?? ''}"
            onchange="${M}?.setUnitSetting('scenarioCost', this.value)"/><span>₽</span>
        </label>
        <label class="an2-unit-ctl">
          <input type="checkbox" ${st.includeFacts ? 'checked' : ''} onchange="${M}?.setUnitSetting('includeFacts', this.checked)"/>
          <span>Учитывать фактические штрафы и удержания</span>
        </label>
        ${s.isOzon && !s.perfConnected ? `
          <button class="an2-btn ghost an2-unit-connect" onclick="${M}?.openSettings()">Подключить рекламу Ozon →</button>` : ''}
      </div>
    </div>
  `;
}

function renderKpis(r: UnitEconResult): string {
  return `
    <div class="an2-kpi-grid an2-unit-kpis">
      ${renderKpiCard({ label: 'Выручка заказанная', value: r.orderedRevenue, exact: true, tint: 'rgba(212,240,0,.18)',
        hint: `${fmtNum(r.orderedUnits)} шт · ${fmtNum(r.orders)} заказов${r.cancelledUnits ? ` · уже отменено ${fmtNum(r.cancelledUnits)} шт` : ''}`,
        tooltip: 'Сумма всех заказов периода по цене покупателя, включая ещё не доставленные и отменённые.' })}
      ${renderKpiCard({ label: `Выкуп ${fmtPct(r.buyoutPct, 0)}`, value: r.boughtRevenue, exact: true, tint: 'rgba(16,185,129,.18)',
        hint: `${fmtQty(r.boughtUnits)} шт · ср. цена ${fmtRub2(r.avgPrice)}`,
        tooltip: `Сколько штук и денег из заказов периода ожидается выкупить. Процент выкупа ${r.buyoutSource}.` })}
      ${renderKpiCard({ label: 'Реклама', value: r.ads.total, exact: true, tint: 'rgba(245,158,11,.18)', invertDelta: true,
        hint: `ДРР ${pctPair(r.ads.drrOrdered, r.ads.drrBought)}`,
        tooltip: 'ДРР — доля рекламных расходов: от заказанной выручки / от ожидаемой выкупленной.' })}
      ${renderKpiCard({ label: 'Итоговая прибыль', value: r.profit, exact: true, tint: r.profit >= 0 ? 'rgba(34,197,94,.18)' : 'rgba(248,113,113,.18)',
        hint: `маржа ${fmtPct(r.margin)} от выкупа`,
        tooltip: 'Ожидаемая выкупленная выручка минус себестоимость, удержания маркетплейса, налог, обратная логистика, реклама и фактические штрафы/удержания.' })}
      ${renderKpiCard({ label: 'Прибыль на выкуп. шт', value: r.profitPerUnit, exact: true, tint: 'rgba(96,165,250,.18)',
        hint: `${fmtRub2(r.profitPerUnit)} · реклама ${fmtRub2(r.ads.perBoughtUnit)}/шт` })}
      ${renderKpiCard({ label: 'ROI', value: r.roi ?? 0, format: 'pct', tint: 'rgba(167,139,250,.18)',
        hint: r.roi == null ? 'нет себестоимости' : `прибыль ÷ себестоимость ${fmtFull(r.cogsTotal)}`,
        tooltip: 'ROI = итоговая прибыль ÷ себестоимость выкупленных штук × 100%.' })}
    </div>
  `;
}

function renderCosts(r: UnitEconResult): string {
  const rows = r.costs.filter(c => c.key !== 'ads');
  const ads = r.costs.find(c => c.key === 'ads');
  return `
    <div class="an2-card">
      <div class="an2-card-head">
        <div class="an2-card-title">Расходы на выкупленную штуку</div>
        <div class="an2-unit-muted">средняя цена ${fmtRub2(r.avgPrice)}</div>
      </div>
      <table class="an2-table an2-unit-costs">
        <thead><tr><th>Статья</th><th class="num">₽ / шт</th><th class="num">% цены</th><th class="num">За период</th></tr></thead>
        <tbody>
          <tr class="an2-unit-price"><td>Цена выкупленной штуки</td><td class="num">${fmtRub2(r.avgPrice)}</td><td class="num">100%</td><td class="num">${fmtFull(r.boughtRevenue)}</td></tr>
          ${rows.map(c => `
            <tr title="Источник: ${escapeHtml(c.source)}">
              <td>${escapeHtml(c.label)}<div class="an2-unit-src">${escapeHtml(c.source)}</div></td>
              <td class="num">${c.total ? fmtRub2(c.perUnit) : '<span class="an2-unit-muted">—</span>'}</td>
              <td class="num">${c.total ? fmtPct(c.pctOfPrice) : ''}</td>
              <td class="num">${c.total ? fmtFull(c.total) : ''}</td>
            </tr>`).join('')}
          ${ads ? `
            <tr title="Источник: ${escapeHtml(ads.source)}">
              <td>Реклама<div class="an2-unit-src">${escapeHtml(ads.source)}</div></td>
              <td class="num">${fmtRub2(ads.perUnit)}</td><td class="num">${fmtPct(ads.pctOfPrice)}</td><td class="num">${fmtFull(ads.total)}</td>
            </tr>` : ''}
          ${r.profitTax > 0 ? `<tr><td colspan="4" class="an2-unit-muted">Налог с прибыли за период ${fmtFull(r.profitTax)} включён в строку налога.</td></tr>` : ''}
          <tr class="an2-unit-total ${r.profitPerUnit >= 0 ? 'pos' : 'neg'}">
            <td>Прибыль на выкупленную штуку</td>
            <td class="num">${fmtRub2(r.profitPerUnit)}</td>
            <td class="num">${fmtPct(r.margin)}</td>
            <td class="num">${fmtFull(r.profit)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderAds(r: UnitEconResult, s: UnitTabState): string {
  const a = r.ads;
  const line = (label: string, money: number, drrO: number, drrB: number) => `
    <div class="an2-unit-adrow">
      <span>${escapeHtml(label)}</span>
      <strong>${fmtRub2(money)}</strong>
      <span class="an2-unit-muted">ДРР ${pctPair(drrO, drrB)}</span>
    </div>`;
  const empty = a.total === 0 && a.source === 'none';
  return `
    <div class="an2-card">
      <div class="an2-card-head">
        <div class="an2-card-title">Реклама</div>
        <div class="an2-unit-muted">${escapeHtml(sourceLabel(a.source))}</div>
      </div>
      ${empty ? `
        <div class="an2-unit-empty">
          Расход на рекламу не получен.
          ${s.isOzon ? `<button class="an2-btn" onclick="${M}?.openSettings()">Подключить Ozon Performance</button>` : 'Добавьте расход вручную в настройках.'}
        </div>` : `
        <div class="an2-unit-adsum">
          <div><span>Всего</span><strong>${fmtRub2(a.total)}</strong></div>
          <div><span>На заказанную шт</span><strong>${fmtRub2(a.perOrderedUnit)}</strong></div>
          <div><span>На выкупленную шт</span><strong>${fmtRub2(a.perBoughtUnit)}</strong></div>
          <div><span>ДРР общий</span><strong>${pctPair(a.drrOrdered, a.drrBought)}</strong></div>
        </div>
        ${a.groups.length ? `<div class="an2-unit-subhead">По типам размещения</div>${a.groups.map(g => line(g.label, g.money, g.drrOrdered, g.drrBought)).join('')}` : ''}
        ${a.strategies.length ? `<div class="an2-unit-subhead">По стратегиям ставок</div>${a.strategies.map(g => line(g.label, g.money, g.drrOrdered, g.drrBought)).join('')}` : ''}
        ${a.bonus > 0 ? `
          <div class="an2-unit-subhead">Справочно, без влияния на юнитку — оплачено бонусами</div>
          ${a.bonusGroups.map(b => `<div class="an2-unit-adrow"><span>${escapeHtml(b.label)}</span><strong>${fmtRub2(b.amount)}</strong><span></span></div>`).join('')}
        ` : ''}
        <div class="an2-unit-note">Первое значение ДРР — от заказанной выручки, второе — от ожидаемой выкупленной.</div>
      `}
    </div>
  `;
}

function sourceLabel(src: UnitEconResult['ads']['source']): string {
  switch (src) {
    case 'performance': return 'Ozon Performance API';
    case 'finance': return 'из финотчёта маркетплейса';
    case 'manual': return 'ручные записи';
    default: return 'не подключено';
  }
}

function renderScenario(r: UnitEconResult, st: UnitEconSettings): string {
  const sc = r.scenario;
  const cur = r.boughtUnits > 0 ? r.cogsTotal / r.boughtUnits : 0;
  return `
    <div class="an2-card">
      <div class="an2-card-head"><div class="an2-card-title">Сценарий себестоимости</div></div>
      <div class="an2-unit-scenario">
        <label class="an2-unit-ctl">
          <span>Себестоимость за шт</span>
          <input type="number" min="0" step="1" value="${st.scenarioCost ?? ''}" placeholder="${Math.round(cur)}"
            onchange="${M}?.setUnitSetting('scenarioCost', this.value)"/><span>₽</span>
          ${sc ? `<button class="an2-btn ghost" onclick="${M}?.setUnitSetting('scenarioCost', '')">Сбросить</button>` : ''}
        </label>
        <table class="an2-table">
          <thead><tr><th></th><th class="num">Сейчас</th><th class="num">${sc ? `При ${fmtRub2(sc.cost)}` : 'Сценарий'}</th></tr></thead>
          <tbody>
            <tr><td>Себестоимость / шт</td><td class="num">${fmtRub2(cur)}</td><td class="num">${sc ? fmtRub2(sc.cost) : '—'}</td></tr>
            <tr><td>Итоговая прибыль</td><td class="num">${fmtRub2(r.profit)}</td><td class="num ${sc ? (sc.profit >= r.profit ? 'pos' : 'neg') : ''}">${sc ? fmtRub2(sc.profit) : '—'}</td></tr>
            <tr><td>Прибыль / выкуп. шт</td><td class="num">${fmtRub2(r.profitPerUnit)}</td><td class="num">${sc ? fmtRub2(sc.profitPerUnit) : '—'}</td></tr>
            <tr><td>ROI</td><td class="num">${r.roi == null ? '—' : fmtPct(r.roi, 2)}</td><td class="num">${sc?.roi == null ? '—' : fmtPct(sc.roi, 2)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderFacts(r: UnitEconResult): string {
  const fact = (label: string, v: number | null) => `
    <div class="an2-unit-fact">
      <span>${label}</span>
      ${v == null ? '<span class="an2-unit-muted">не получены</span>' : `<strong>${fmtRub2(v)}</strong>`}
    </div>`;
  return `
    <div class="an2-card">
      <div class="an2-card-head"><div class="an2-card-title">Факт за период</div>
        <div class="an2-unit-muted">${r.facts.included ? 'входит в прибыль' : 'справочно'}</div></div>
      ${r.fbs ? `
        <div class="an2-unit-subhead">FBS передано в доставку</div>
        <div class="an2-unit-fact"><span>Отправления</span><strong>${fmtNum(r.fbs.postings)}</strong></div>
        <div class="an2-unit-fact"><span>Штук</span><strong>${fmtNum(r.fbs.units)}</strong></div>
        <div class="an2-unit-fact"><span>Выручка этих отправлений</span><strong>${fmtFull(r.fbs.revenue)}</strong></div>
      ` : ''}
      <div class="an2-unit-subhead">Удержания из финотчёта</div>
      ${fact('Штрафы', r.facts.penalties)}
      ${fact('Хранение', r.facts.storage)}
      ${fact('Прочие удержания', r.facts.other)}
    </div>
  `;
}

const SORT_COLS: Array<[UnitSortKey, string]> = [
  ['orderedUnits', 'Заказано'], ['buyoutPct', 'Выкуп'], ['orderedRevenue', 'Выручка заказ.'],
  ['ads', 'Реклама'], ['drrBought', 'ДРР выкуп'], ['profitPerUnit', 'Прибыль/шт'], ['profit', 'Прибыль'], ['roi', 'ROI'],
];

export function sortUnitRows(rows: UnitSkuRow[], sort: UnitTabState['sort']): UnitSkuRow[] {
  return [...rows].sort((a, b) => ((a[sort.key] ?? -Infinity) as number) > ((b[sort.key] ?? -Infinity) as number) ? sort.dir : -sort.dir);
}

function renderSkuTable(r: UnitEconResult, sort: UnitTabState['sort']): string {
  const rows = sortUnitRows(r.skus, sort);
  const th = (key: UnitSortKey, label: string) => `
    <th class="num an2-sortable ${sort.key === key ? 'active' : ''}" onclick="${M}?.setUnitSort('${key}')">
      ${label}${sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>`;
  const mark = (basis: string) => basis === 'sku' || basis === 'manual' ? '' : `<span class="an2-unit-approx" title="${BASIS_HINT[basis]}">≈</span>`;
  return `
    <div class="an2-card" style="padding:0;overflow:hidden">
      <div class="an2-card-head" style="padding:14px 16px 0">
        <div class="an2-card-title">По товарам · ${fmtNum(r.skus.length)}</div>
        <div class="an2-unit-muted">≈ — значение взято средним по магазину</div>
      </div>
      <div style="overflow-x:auto">
        <table class="an2-table an2-unit-skus">
          <thead><tr>
            <th>Товар</th>
            ${th(SORT_COLS[0][0], SORT_COLS[0][1])}
            ${th(SORT_COLS[1][0], SORT_COLS[1][1])}
            <th class="num">Цена</th>
            ${th(SORT_COLS[2][0], SORT_COLS[2][1])}
            <th class="num">Себест.</th>
            <th class="num">Комиссия</th>
            <th class="num">Логистика</th>
            ${th(SORT_COLS[3][0], SORT_COLS[3][1])}
            ${th(SORT_COLS[4][0], SORT_COLS[4][1])}
            ${th(SORT_COLS[5][0], SORT_COLS[5][1])}
            ${th(SORT_COLS[6][0], SORT_COLS[6][1])}
            ${th(SORT_COLS[7][0], SORT_COLS[7][1])}
          </tr></thead>
          <tbody>
            ${rows.map(x => `
              <tr>
                <td class="an2-unit-name">
                  <div class="an2-unit-vc"><span class="mp-badge"><span class="mp-dot" style="background:${MP_COLOR[x.mp]}"></span>${MP_SHORT[x.mp]}</span>${escapeHtml(x.vendor_code)}</div>
                  <div class="an2-unit-nm" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</div>
                </td>
                <td class="num">${fmtNum(x.orderedUnits)}</td>
                <td class="num">${fmtPct(x.buyoutPct, 0)}${mark(x.buyoutBasis)}</td>
                <td class="num">${fmtRub2(x.price)}</td>
                <td class="num">${fmtFull(x.orderedRevenue)}</td>
                <td class="num ${x.cogsPerUnit == null ? 'neg' : ''}">${x.cogsPerUnit == null ? 'нет' : fmtRub2(x.cogsPerUnit)}</td>
                <td class="num">${fmtRub2(x.commissionPerUnit)}${mark(x.feesBasis)}</td>
                <td class="num">${fmtRub2(x.logisticsPerUnit + x.lastMilePerUnit + x.returnLogisticsPerUnit)}${mark(x.feesBasis)}</td>
                <td class="num">${fmtFull(x.ads)}</td>
                <td class="num">${fmtPct(x.drrBought)}</td>
                <td class="num ${x.profitPerUnit >= 0 ? 'pos' : 'neg'}">${fmtRub2(x.profitPerUnit)}</td>
                <td class="num ${x.profit >= 0 ? 'pos' : 'neg'}">${fmtFull(x.profit)}</td>
                <td class="num">${x.roi == null ? '—' : fmtPct(x.roi, 0)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderNuances(r: UnitEconResult): string {
  if (!r.nuances.length) return '';
  const warn = r.nuances.filter(n => n.level === 'warn').length;
  return `
    <details class="an2-card an2-unit-nuances" ${warn ? 'open' : ''}>
      <summary class="an2-card-title">Нюансы расчёта · ${r.nuances.length}${warn ? ` <span class="an2-unit-warnbadge">${warn} важн.</span>` : ''}</summary>
      <ul>
        ${r.nuances.map(n => `<li class="${n.level}">${escapeHtml(n.text)}</li>`).join('')}
      </ul>
    </details>
  `;
}

// ── Текстовый отчёт и выгрузка ──────────────────────────────────────────

const rub = (v: number) => fmtRub2(v);
const nf = (v: number) => v == null ? 'не получены' : rub(v);

/** Отчёт в виде текста — для мессенджера. */
export function unitReportText(r: UnitEconResult, title: string): string {
  const L: string[] = [];
  L.push(`Юнит-экономика · ${title}`);
  L.push(`Итого: ${fmtNum(r.orderedUnits)} шт., ${fmtNum(r.orders)} заказов`);
  L.push(`Выручка заказанная: ${fmtFull(r.orderedRevenue)}`);
  L.push(`Ожидаемый выкуп ${fmtPct(r.buyoutPct, 0)}: ${fmtQty(r.boughtUnits)} шт.; выкупленная выручка ${fmtFull(r.boughtRevenue)}`);
  L.push('');
  L.push(`Реклама всего: ${rub(r.ads.total)}`);
  L.push(`• на заказанную шт: ${rub(r.ads.perOrderedUnit)}`);
  L.push(`• на выкуп. шт: ${rub(r.ads.perBoughtUnit)}`);
  L.push(`ДРР общий: ${pctPair(r.ads.drrOrdered, r.ads.drrBought)}`);
  for (const g of r.ads.groups) L.push(`• ${g.label}: ${rub(g.money)}; ДРР ${pctPair(g.drrOrdered, g.drrBought)}`);
  if (r.ads.strategies.length) {
    L.push('По стратегиям:');
    for (const g of r.ads.strategies) L.push(`• ${g.label}: ${rub(g.money)}; ДРР ${pctPair(g.drrOrdered, g.drrBought)}`);
  }
  if (r.ads.bonus > 0) {
    L.push('Справочно, без влияния на юнитку (бонусы):');
    for (const b of r.ads.bonusGroups) L.push(`• ${b.label}: ${rub(b.amount)}`);
  }
  L.push('');
  L.push('Расходы на выкуп. шт:');
  for (const c of r.costs) if (c.key !== 'ads') L.push(`• ${c.label.toLowerCase()}: ${c.total ? rub(c.perUnit) : 'нет данных'}`);
  L.push(`• штрафы: ${nf(r.facts.penalties as number)}`);
  L.push(`• прочие удержания: ${nf(r.facts.other as number)}`);
  L.push('');
  L.push(`Итоговая прибыль: ${rub(r.profit)}`);
  L.push(`Прибыль/выкуп. шт: ${rub(r.profitPerUnit)}`);
  L.push(`ROI: ${r.roi == null ? '—' : fmtPct(r.roi, 2)}`);
  if (r.scenario) {
    L.push('');
    L.push(`Сценарий себестоимость ${rub(r.scenario.cost)}:`);
    L.push(`• итоговая прибыль: ${rub(r.scenario.profit)}`);
    L.push(`• прибыль/выкуп. шт: ${rub(r.scenario.profitPerUnit)}`);
    L.push(`• ROI: ${r.scenario.roi == null ? '—' : fmtPct(r.scenario.roi, 2)}`);
  }
  if (r.fbs) {
    L.push('');
    L.push(`FBS передано за период: ${fmtNum(r.fbs.units)} шт., ${fmtNum(r.fbs.postings)} отправлений`);
    L.push(`Выручка этих FBS: ${fmtFull(r.fbs.revenue)}`);
  }
  if (r.nuances.length) {
    L.push('');
    L.push(`Нюансы: ${r.nuances.length}`);
    for (const n of r.nuances) L.push(`• ${n.text}`);
  }
  return L.join('\n');
}

export function unitSheets(r: UnitEconResult, title: string): Sheet[] {
  return [
    {
      name: 'Итоги',
      rows: [
        ['Показатель', 'Значение'],
        ['Период', title],
        ['Заказов', r.orders],
        ['Заказано, шт', r.orderedUnits],
        ['Выручка заказанная, ₽', r.orderedRevenue],
        ['Ожидаемый выкуп, %', r.buyoutPct],
        ['Выкуплено, шт', r.boughtUnits],
        ['Выручка выкупленная, ₽', r.boughtRevenue],
        ['Реклама, ₽', r.ads.total],
        ['ДРР от заказанной, %', r.ads.drrOrdered],
        ['ДРР от выкупленной, %', r.ads.drrBought],
        ['Итоговая прибыль, ₽', r.profit],
        ['Прибыль на выкуп. шт, ₽', r.profitPerUnit],
        ['ROI, %', r.roi],
        ['Штрафы фактом, ₽', r.facts.penalties],
        ['Хранение фактом, ₽', r.facts.storage],
        ['Прочие удержания фактом, ₽', r.facts.other],
        ...(r.scenario ? [
          ['Сценарий: себестоимость, ₽', r.scenario.cost],
          ['Сценарий: прибыль, ₽', r.scenario.profit],
          ['Сценарий: ROI, %', r.scenario.roi],
        ] as Array<[string, number | null]> : []),
      ],
    },
    {
      name: 'Расходы на шт',
      rows: [['Статья', '₽ на выкуп. шт', '% цены', 'За период, ₽', 'Источник'],
        ...r.costs.map(c => [c.label, c.perUnit, c.pctOfPrice, c.total, c.source])],
      formats: { 1: 'money2', 2: 'pct', 3: 'money2' },
    },
    {
      name: 'Реклама',
      rows: [['Группа', 'Расход, ₽', 'ДРР заказ, %', 'ДРР выкуп, %'],
        ...r.ads.groups.map(g => [g.label, g.money, g.drrOrdered, g.drrBought]),
        ...r.ads.strategies.map(g => [`Стратегия: ${g.label}`, g.money, g.drrOrdered, g.drrBought]),
        ...r.ads.bonusGroups.map(b => [`Бонусы (справочно): ${b.label}`, b.amount, null, null])],
      formats: { 1: 'money2', 2: 'pct', 3: 'pct' },
    },
    {
      name: 'Товары',
      rows: [['МП', 'Артикул', 'SKU', 'Название', 'Заказов', 'Заказано, шт', 'Цена, ₽', 'Выручка заказ., ₽', 'Выкуп, %', 'Выкуп по',
        'Выкуплено, шт', 'Себест./шт', 'Комиссия/шт', 'Налог/шт', 'Эквайринг/шт', 'Логистика/шт', 'Посл. миля/шт',
        'Обр. логистика/шт', 'Прочее/шт', 'Ставки по', 'Реклама, ₽', 'ДРР заказ, %', 'ДРР выкуп, %', 'Прибыль/шт', 'Прибыль, ₽', 'ROI, %', 'Маржа, %'],
        ...r.skus.map(x => [MP_SHORT[x.mp], x.vendor_code, x.mp_sku, x.name, x.orders, x.orderedUnits, x.price, x.orderedRevenue,
          x.buyoutPct, BASIS_HINT[x.buyoutBasis], x.boughtUnits, x.cogsPerUnit, x.commissionPerUnit, x.taxPerUnit, x.acquiringPerUnit,
          x.logisticsPerUnit, x.lastMilePerUnit, x.returnLogisticsPerUnit, x.otherPerUnit, BASIS_HINT[x.feesBasis], x.ads,
          x.drrOrdered, x.drrBought, x.profitPerUnit, x.profit, x.roi, x.margin])],
      formats: { 6: 'money2', 7: 'money', 8: 'pct', 10: 'qty', 11: 'money2', 12: 'money2', 13: 'money2', 14: 'money2', 15: 'money2',
        16: 'money2', 17: 'money2', 18: 'money2', 20: 'money2', 21: 'pct', 22: 'pct', 23: 'money2', 24: 'money2', 25: 'pct', 26: 'pct' },
    },
    { name: 'Нюансы', rows: [['Уровень', 'Текст'], ...r.nuances.map(n => [n.level === 'warn' ? 'важно' : 'инфо', n.text])] },
  ];
}
