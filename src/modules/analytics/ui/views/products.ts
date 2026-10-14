/** «Товары» — прибыль по каждому артикулу, ABC, сортировка по любой колонке. */

import { SkuPerformance, MP_SHORT } from '../../types';
import { rub, num, pct, escapeHtml } from '../format';

export type ProductsSort = 'profit' | 'revenue' | 'units' | 'margin' | 'profit_per_unit' | 'returns' | 'cogs' | 'fees';

export interface ProductsState {
  search: string;
  sort: ProductsSort;
  dir: 1 | -1;
  limit: number;
}

export const PRODUCTS_PAGE = 100;

/** ABC по выручке: A — первые 80%, B — следующие 15%, C — остальное. */
export function abcClasses(skus: SkuPerformance[]): Map<string, 'A' | 'B' | 'C'> {
  const total = skus.reduce((s, x) => s + Math.max(0, x.revenue), 0);
  const out = new Map<string, 'A' | 'B' | 'C'>();
  let acc = 0;
  for (const x of [...skus].sort((a, b) => b.revenue - a.revenue)) {
    const key = `${x.mp}|${x.vendor_code}`;
    if (total <= 0 || x.revenue <= 0) { out.set(key, 'C'); continue; }
    const before = acc / total;
    acc += x.revenue;
    out.set(key, before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C');
  }
  return out;
}

const fees = (x: SkuPerformance) => x.commission + x.logistics + x.services + x.tax + x.period_costs + x.manual_costs;
const VAL: Record<ProductsSort, (x: SkuPerformance) => number> = {
  profit: x => x.net_profit, revenue: x => x.revenue, units: x => x.units_sold, margin: x => x.margin_pct,
  profit_per_unit: x => x.profit_per_unit, returns: x => x.return_rate_pct, cogs: x => x.cogs, fees,
};

const M = 'window.analyticsModule';

export function renderProducts(all: SkuPerformance[], st: ProductsState): string {
  const abc = abcClasses(all);
  const q = st.search.trim().toLowerCase();
  const list = (q ? all.filter(s => `${s.vendor_code} ${s.name}`.toLowerCase().includes(q)) : [...all])
    .sort((a, b) => (VAL[st.sort](a) - VAL[st.sort](b)) * st.dir);
  const count = (c: string) => [...abc.values()].filter(v => v === c).length;
  const maxProfit = Math.max(1, ...list.map(x => Math.abs(x.net_profit)));
  const missing = all.reduce((s, x) => s + x.missing_cogs_units, 0);

  const th = (key: ProductsSort, label: string, title = '') =>
    `<th class="num sortable ${st.sort === key ? 'on' : ''}" title="${title}" onclick="${M}?.sortProducts('${key}')">${label}${st.sort === key ? (st.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;

  return `
    <div class="an-toolbar">
      <input class="an-search" type="search" placeholder="Поиск по артикулу или названию" value="${escapeHtml(st.search)}"
        oninput="${M}?.setProductsSearch(this.value)"/>
      <span class="an-grow"></span>
      <span class="an-muted">${num(all.length)} товаров · <span class="an-abc A">A</span> ${count('A')} <span class="an-abc B">B</span> ${count('B')} <span class="an-abc C">C</span> ${count('C')}</span>
    </div>
    ${missing ? `<div class="an-alert warn">Не задана себестоимость для ${num(missing)} проданных шт — прибыль по ним завышена.
      <button class="an-link" onclick="${M}?.openCostEditor()">Заполнить →</button></div>` : ''}
    <section class="an-card flush">
      ${list.length === 0 ? '<div class="an-empty"><h3>Нет товаров</h3><p>За период не было продаж — или поиск слишком узкий.</p></div>' : `
      <div class="an-scroll">
        <table class="an-table">
          <thead><tr>
            <th>Товар</th><th title="ABC по выручке">ABC</th>
            ${th('units', 'Продано')}${th('returns', 'Возвраты', 'Доля возвращённых штук')}${th('revenue', 'Выручка')}
            ${th('fees', 'Удержания', 'Комиссия, логистика, услуги, налог и доля общих расходов')}${th('cogs', 'Себестоимость')}
            ${th('profit_per_unit', 'Прибыль/шт')}${th('profit', 'Прибыль')}${th('margin', 'Маржа')}
          </tr></thead>
          <tbody>${list.slice(0, st.limit).map(x => `
            <tr>
              <td class="an-prod"><span class="an-mp an-mp-${x.mp}">${MP_SHORT[x.mp]}</span><div><b title="${escapeHtml(x.name)}">${escapeHtml(x.name || x.vendor_code)}</b><small>${escapeHtml(x.vendor_code)}${x.missing_cogs_units ? ' · <span class="neg">нет себестоимости</span>' : ''}</small></div></td>
              <td><span class="an-abc ${abc.get(`${x.mp}|${x.vendor_code}`) ?? 'C'}">${abc.get(`${x.mp}|${x.vendor_code}`) ?? 'C'}</span></td>
              <td class="num">${num(x.units_sold)}</td>
              <td class="num ${x.return_rate_pct >= 10 ? 'neg' : ''}">${pct(x.return_rate_pct)}</td>
              <td class="num">${rub(x.revenue)}</td>
              <td class="num">${rub(fees(x))}</td>
              <td class="num">${rub(x.cogs)}</td>
              <td class="num ${x.profit_per_unit >= 0 ? 'pos' : 'neg'}">${rub(x.profit_per_unit)}</td>
              <td class="num an-barcell ${x.net_profit >= 0 ? 'pos' : 'neg'}">
                <span class="an-inbar ${x.net_profit >= 0 ? '' : 'neg'}" style="width:${Math.abs(x.net_profit) / maxProfit * 100}%"></span>${rub(x.net_profit)}</td>
              <td class="num">${pct(x.margin_pct)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${list.length > st.limit ? `<div class="an-more"><button class="an-btn ghost" onclick="${M}?.showMoreProducts()">Показать ещё ${num(Math.min(PRODUCTS_PAGE, list.length - st.limit))} из ${num(list.length - st.limit)}</button></div>` : ''}`}
    </section>
    <p class="an-muted an-note">Прибыль товара = выручка − комиссия − логистика − услуги − налоги − себестоимость − потери на возвратах и отменах − доля общих расходов (реклама, хранение, ваши расходы — пропорционально выручке). Сумма по всем товарам равна чистой прибыли в «Обзоре».</p>
  `;
}
