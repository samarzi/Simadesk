/**
 * «Юнит-экономика» — прогноз прибыли по заказам периода:
 * заказано → ожидаемый выкуп → расходы на штуку → прибыль и ROI.
 */

import { MP_SHORT } from '../../types';
import { UnitEconResult, UnitEconSettings, UnitSkuRow } from '../../services/unitEconomics';
import { rub, rub2, num, qty, pct, escapeHtml } from '../format';
import { stackBar } from '../charts';

export type UnitSortKey = 'orderedRevenue' | 'orderedUnits' | 'buyoutPct' | 'profit' | 'profitPerUnit' | 'roi' | 'drrBought' | 'ads';

export interface UnitViewInput {
  result: UnitEconResult | null;
  loading: boolean;
  error: string;
  settings: UnitEconSettings;
  sort: { key: UnitSortKey; dir: 1 | -1 };
  isOzon: boolean;
  historyLabel: string;
}

const M = 'window.analyticsModule';
const pair = (a: number, b: number) => `${pct(a, 2)} / ${pct(b, 2)}`;

export function renderUnit(v: UnitViewInput): string {
  const controls = renderControls(v);
  if (v.error) return `${controls}<div class="an-alert error">${escapeHtml(v.error)}</div>`;
  if (!v.result) {
    return `${controls}<div class="an-loading"><div class="an-spinner"></div>
      <p>Считаем: история выкупа и удержаний за 60 дней, реклама, отгрузки…</p></div>`;
  }
  const r = v.result;
  if (!r.orders) return `${controls}<div class="an-empty"><h3>За период нет заказов</h3><p>Выберите другой период или магазин.</p></div>`;

  return `
    ${controls}
    <div class="an-tiles">
      ${t('Заказано', rub(r.orderedRevenue), `${num(r.orderedUnits)} шт · ${num(r.orders)} заказов`)}
      ${t(`Выкуп ${pct(r.buyoutPct, 0)}`, rub(r.boughtRevenue), `${qty(r.boughtUnits)} шт · ${v.settings.buyoutMode === 'manual' ? 'задан вручную' : 'по истории'}`)}
      ${t('Реклама', rub(r.ads.total), `ДРР ${pair(r.ads.drrOrdered, r.ads.drrBought)}`)}
      ${t('Прибыль', rub(r.profit), `маржа ${pct(r.margin)}`, r.profit < 0)}
      ${t('На выкупленную шт', rub2(r.profitPerUnit), `реклама ${rub2(r.ads.perBoughtUnit)} на шт`, r.profitPerUnit < 0)}
      ${t('ROI', r.roi == null ? '—' : pct(r.roi), r.roi == null ? 'нет себестоимости' : `на себестоимость ${rub(r.cogsTotal)}`)}
    </div>

    <section class="an-card">
      <header class="an-card-head"><div><h3>Из чего состоит цена</h3>
        <p class="an-muted">средняя цена выкупленной штуки ${rub2(r.avgPrice)}</p></div></header>
      ${priceStack(r)}
    </section>

    <div class="an-grid2">
      ${costTable(r)}
      ${adsCard(r, v)}
    </div>

    <div class="an-grid2">
      ${scenarioCard(r, v.settings)}
      ${factsCard(r)}
    </div>

    ${skuTable(r, v.sort)}
    ${nuances(r)}
  `;
}

function t(label: string, value: string, hint: string, bad = false): string {
  return `<div class="an-tile"><div class="an-tile-label">${escapeHtml(label)}</div>
    <div class="an-tile-value ${bad ? 'neg' : ''}">${value}</div>
    <div class="an-tile-foot"><span class="an-tile-hint">${escapeHtml(hint)}</span></div></div>`;
}

function renderControls(v: UnitViewInput): string {
  const s = v.settings;
  return `
    <div class="an-toolbar">
      <label class="an-field">
        <span>Выкуп</span>
        <select onchange="${M}?.setUnitSetting('buyoutMode', this.value)">
          <option value="auto" ${s.buyoutMode === 'auto' ? 'selected' : ''}>по истории товара</option>
          <option value="manual" ${s.buyoutMode === 'manual' ? 'selected' : ''}>задать вручную</option>
        </select>
        <input type="number" min="1" max="100" value="${s.buyoutPct}" onchange="${M}?.setUnitSetting('buyoutPct', this.value)"
          title="${s.buyoutMode === 'manual' ? 'Процент выкупа для всех товаров' : 'Для товаров без истории'}"/>%
      </label>
      <label class="an-field">
        <span>Если себестоимость</span>
        <input type="number" min="0" placeholder="₽ за шт" value="${s.scenarioCost ?? ''}" onchange="${M}?.setUnitSetting('scenarioCost', this.value)"/>₽
      </label>
      <label class="an-check">
        <input type="checkbox" ${s.includeFacts ? 'checked' : ''} onchange="${M}?.setUnitSetting('includeFacts', this.checked)"/>
        учитывать штрафы и удержания
      </label>
      <span class="an-grow"></span>
      ${v.loading ? '<span class="an-muted"><span class="an-spinner sm"></span> пересчёт…</span>' : ''}
      <button class="an-btn ghost" onclick="${M}?.copyUnitReport(this)">Скопировать отчёт</button>
      <button class="an-btn ghost" onclick="${M}?.exportUnit('json')">JSON</button>
    </div>
    <p class="an-muted an-note">Выкуп и ставки маркетплейса берутся из финотчётов ${escapeHtml(v.historyLabel)} — по каждому товару отдельно.</p>
    ${v.isOzon && v.result?.ads.source !== 'performance' && v.result
      ? `<div class="an-alert info">Расходы на рекламу Ozon сейчас ${v.result.ads.source === 'none' ? 'не получены' : 'взяты из финотчёта и за свежие дни неполные'}.
          <button class="an-link" onclick="${M}?.openSettings()">Подключить рекламный кабинет →</button></div>` : ''}
  `;
}

function priceStack(r: UnitEconResult): string {
  const c = Object.fromEntries(r.costs.map(x => [x.key, x.perUnit]));
  const logistics = (c.logistics ?? 0) + (c.last_mile ?? 0) + (c.return_logistics ?? 0);
  const other = (c.acquiring ?? 0) + (c.other ?? 0);
  const parts = [
    { label: 'Себестоимость', value: c.cogs ?? 0, color: 'var(--an-s7)', valueText: rub2(c.cogs ?? 0) },
    { label: 'Комиссия', value: c.commission ?? 0, color: 'var(--an-s2)', valueText: rub2(c.commission ?? 0) },
    { label: 'Логистика', value: logistics, color: 'var(--an-s4)', valueText: rub2(logistics) },
    { label: 'Реклама', value: c.ads ?? 0, color: 'var(--an-s5)', valueText: rub2(c.ads ?? 0) },
    { label: 'Налог', value: c.tax ?? 0, color: 'var(--an-s1)', valueText: rub2(c.tax ?? 0) },
    { label: 'Эквайринг и прочее', value: other, color: 'var(--an-muted-fill)', valueText: rub2(other) },
    { label: r.profitPerUnit >= 0 ? 'Прибыль' : 'Убыток', value: Math.max(0, r.profitPerUnit), color: 'var(--an-s3)', valueText: rub2(r.profitPerUnit) },
  ];
  // Нулевые статьи в легенде — шум; прибыль/убыток показываем всегда.
  return stackBar(parts.filter((p, i) => i === parts.length - 1 || Math.abs(p.value) >= 0.005));
}

function costTable(r: UnitEconResult): string {
  return `
    <section class="an-card">
      <header class="an-card-head"><div><h3>Расходы на выкупленную штуку</h3></div></header>
      <table class="an-table compact">
        <thead><tr><th>Статья</th><th class="num">₽ / шт</th><th class="num">% цены</th><th class="num">За период</th></tr></thead>
        <tbody>
          <tr class="strong"><td>Цена</td><td class="num">${rub2(r.avgPrice)}</td><td class="num">100%</td><td class="num">${rub(r.boughtRevenue)}</td></tr>
          ${r.costs.map(c => `
            <tr title="Источник: ${escapeHtml(c.source)}">
              <td>${escapeHtml(c.label)}<div class="an-src">${escapeHtml(c.source)}</div></td>
              <td class="num">${c.total ? rub2(c.perUnit) : '—'}</td>
              <td class="num">${c.total ? pct(c.pctOfPrice) : ''}</td>
              <td class="num">${c.total ? rub(c.total) : ''}</td>
            </tr>`).join('')}
          <tr class="total ${r.profit >= 0 ? 'pos' : 'neg'}">
            <td>Прибыль</td><td class="num">${rub2(r.profitPerUnit)}</td><td class="num">${pct(r.margin)}</td><td class="num">${rub(r.profit)}</td>
          </tr>
        </tbody>
      </table>
    </section>`;
}

function adsCard(r: UnitEconResult, v: UnitViewInput): string {
  const a = r.ads;
  const row = (label: string, money: number, o: number, b: number) => `
    <div class="an-kv"><span>${escapeHtml(label)}</span><strong>${rub2(money)}</strong><em>ДРР ${pair(o, b)}</em></div>`;
  return `
    <section class="an-card">
      <header class="an-card-head"><div><h3>Реклама</h3><p class="an-muted">${escapeHtml(sourceLabel(a.source))}</p></div></header>
      ${a.total === 0 && a.source === 'none' ? `
        <div class="an-chart-empty">Расход на рекламу не получен.
          ${v.isOzon ? `<button class="an-btn" onclick="${M}?.openSettings()">Подключить Ozon Performance</button>` : 'Добавьте расход вручную в настройках.'}</div>` : `
        <div class="an-mini-tiles">
          <div><span>Всего</span><strong>${rub2(a.total)}</strong></div>
          <div><span>На заказанную шт</span><strong>${rub2(a.perOrderedUnit)}</strong></div>
          <div><span>На выкупленную шт</span><strong>${rub2(a.perBoughtUnit)}</strong></div>
          <div><span>ДРР заказ / выкуп</span><strong>${pair(a.drrOrdered, a.drrBought)}</strong></div>
        </div>
        ${a.groups.length ? `<h4>По размещению</h4>${a.groups.map(g => row(g.label, g.money, g.drrOrdered, g.drrBought)).join('')}` : ''}
        ${a.strategies.length ? `<h4>По стратегиям</h4>${a.strategies.map(g => row(g.label, g.money, g.drrOrdered, g.drrBought)).join('')}` : ''}
        ${a.bonus > 0 ? `<h4>Оплачено бонусами — справочно, в прибыль не входит</h4>
          ${a.bonusGroups.map(b => `<div class="an-kv"><span>${escapeHtml(b.label)}</span><strong>${rub2(b.amount)}</strong><em></em></div>`).join('')}` : ''}
      `}
    </section>`;
}

function sourceLabel(s: UnitEconResult['ads']['source']): string {
  return s === 'performance' ? 'из рекламного кабинета Ozon'
    : s === 'finance' ? 'из финотчёта маркетплейса'
    : s === 'manual' ? 'из ваших записей' : 'не подключено';
}

function scenarioCard(r: UnitEconResult, st: UnitEconSettings): string {
  const sc = r.scenario;
  const cur = r.boughtUnits > 0 ? r.cogsTotal / r.boughtUnits : 0;
  const cell = (a: string, b: string, better?: boolean) => `<td class="num">${a}</td><td class="num ${better == null ? '' : better ? 'pos' : 'neg'}">${b}</td>`;
  return `
    <section class="an-card">
      <header class="an-card-head"><div><h3>Что если изменить себестоимость</h3></div></header>
      <div class="an-toolbar flat">
        <label class="an-field"><span>Себестоимость за шт</span>
          <input type="number" min="0" value="${st.scenarioCost ?? ''}" placeholder="${Math.round(cur)}" onchange="${M}?.setUnitSetting('scenarioCost', this.value)"/>₽</label>
        ${sc ? `<button class="an-btn ghost" onclick="${M}?.setUnitSetting('scenarioCost', '')">Сбросить</button>` : ''}
      </div>
      <table class="an-table compact">
        <thead><tr><th></th><th class="num">Сейчас</th><th class="num">${sc ? `При ${rub2(sc.cost)}` : 'Сценарий'}</th></tr></thead>
        <tbody>
          <tr><td>Себестоимость / шт</td>${cell(rub2(cur), sc ? rub2(sc.cost) : '—')}</tr>
          <tr><td>Прибыль</td>${cell(rub(r.profit), sc ? rub(sc.profit) : '—', sc ? sc.profit >= r.profit : undefined)}</tr>
          <tr><td>Прибыль / шт</td>${cell(rub2(r.profitPerUnit), sc ? rub2(sc.profitPerUnit) : '—')}</tr>
          <tr><td>ROI</td>${cell(r.roi == null ? '—' : pct(r.roi), sc?.roi == null ? '—' : pct(sc.roi))}</tr>
        </tbody>
      </table>
    </section>`;
}

function factsCard(r: UnitEconResult): string {
  const f = (label: string, v: number | null) =>
    `<div class="an-kv"><span>${label}</span>${v == null ? '<em>не получены</em>' : `<strong>${rub2(v)}</strong>`}<em></em></div>`;
  return `
    <section class="an-card">
      <header class="an-card-head"><div><h3>Факт за период</h3><p class="an-muted">${r.facts.included ? 'удержания входят в прибыль' : 'справочно'}</p></div></header>
      ${r.fbs ? `<h4>Передано в доставку FBS</h4>
        <div class="an-mini-tiles three">
          <div><span>Отправлений</span><strong>${num(r.fbs.postings)}</strong></div>
          <div><span>Штук</span><strong>${num(r.fbs.units)}</strong></div>
          <div><span>На сумму</span><strong>${rub(r.fbs.revenue)}</strong></div>
        </div>` : ''}
      <h4>Удержания маркетплейса</h4>
      ${f('Штрафы', r.facts.penalties)}
      ${f('Хранение', r.facts.storage)}
      ${f('Прочие удержания', r.facts.other)}
    </section>`;
}

const COLS: Array<[UnitSortKey, string]> = [
  ['orderedUnits', 'Заказано'], ['buyoutPct', 'Выкуп'], ['orderedRevenue', 'Выручка'],
  ['ads', 'Реклама'], ['drrBought', 'ДРР'], ['profitPerUnit', 'Прибыль/шт'], ['profit', 'Прибыль'], ['roi', 'ROI'],
];

export function sortUnitRows(rows: UnitSkuRow[], sort: UnitViewInput['sort']): UnitSkuRow[] {
  const v = (r: UnitSkuRow) => (r[sort.key] ?? -Infinity) as number;
  return [...rows].sort((a, b) => (v(a) - v(b)) * sort.dir || 0);
}

function skuTable(r: UnitEconResult, sort: UnitViewInput['sort']): string {
  const th = ([key, label]: [UnitSortKey, string]) =>
    `<th class="num sortable ${sort.key === key ? 'on' : ''}" onclick="${M}?.setUnitSort('${key}')">${label}${sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
  const approx = (b: string) => b === 'sku' || b === 'manual' ? '' : '<span class="an-approx" title="Среднее по магазину: у товара мало истории">≈</span>';
  return `
    <section class="an-card flush">
      <header class="an-card-head"><div><h3>По товарам</h3><p class="an-muted">${num(r.skus.length)} товаров · ≈ — среднее по магазину</p></div></header>
      <div class="an-scroll">
        <table class="an-table">
          <thead><tr><th>Товар</th>${th(COLS[0])}${th(COLS[1])}<th class="num">Цена</th>${th(COLS[2])}
            <th class="num">Себест.</th><th class="num">Комиссия</th><th class="num">Логистика</th>${th(COLS[3])}${th(COLS[4])}${th(COLS[5])}${th(COLS[6])}${th(COLS[7])}</tr></thead>
          <tbody>${sortUnitRows(r.skus, sort).map(x => `
            <tr>
              <td class="an-prod"><span class="an-mp an-mp-${x.mp}">${MP_SHORT[x.mp]}</span><div><b title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</b><small>${escapeHtml(x.vendor_code)}</small></div></td>
              <td class="num">${num(x.orderedUnits)}</td>
              <td class="num">${pct(x.buyoutPct, 0)}${approx(x.buyoutBasis)}</td>
              <td class="num">${rub2(x.price)}</td>
              <td class="num">${rub(x.orderedRevenue)}</td>
              <td class="num ${x.cogsPerUnit == null ? 'neg' : ''}">${x.cogsPerUnit == null ? 'не задана' : rub2(x.cogsPerUnit)}</td>
              <td class="num">${rub2(x.commissionPerUnit)}${approx(x.feesBasis)}</td>
              <td class="num">${rub2(x.logisticsPerUnit + x.lastMilePerUnit + x.returnLogisticsPerUnit)}${approx(x.feesBasis)}</td>
              <td class="num">${rub(x.ads)}</td>
              <td class="num">${pct(x.drrBought)}</td>
              <td class="num ${x.profitPerUnit >= 0 ? 'pos' : 'neg'}">${rub2(x.profitPerUnit)}</td>
              <td class="num ${x.profit >= 0 ? 'pos' : 'neg'}">${rub(x.profit)}</td>
              <td class="num">${x.roi == null ? '—' : pct(x.roi, 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}

function nuances(r: UnitEconResult): string {
  if (!r.nuances.length) return '';
  const warn = r.nuances.filter(n => n.level === 'warn').length;
  return `
    <details class="an-card an-details" ${warn ? 'open' : ''}>
      <summary><h3>Как посчитано и что учесть</h3><span class="an-muted">${r.nuances.length}${warn ? ` · ${warn} важн.` : ''}</span></summary>
      <ul>${r.nuances.map(n => `<li class="${n.level}">${escapeHtml(n.text)}</li>`).join('')}</ul>
    </details>`;
}
