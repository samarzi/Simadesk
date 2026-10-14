import { Order, MP_SHORT, MP_COLOR, PeriodCost, ManualEntry, SkuPerformance } from '../types';
import { I } from '@/utils/icons';
import { computeSkuPerformance } from '../services/kpiAggregator';
import { fmtMoney, fmtNum, escapeHtml } from '../components/format';
import { copyButton } from '@/utils/copyButton';

export type ProductsSort = 'profit' | 'revenue' | 'units' | 'margin' | 'profit_per_unit' | 'returns' | 'cogs' | 'fees';

export interface ProductsFilters {
  sort: ProductsSort;
  search: string;
  /** 1 — по возрастанию, иначе по убыванию. */
  dir?: 1 | -1;
  /** Сколько строк показано; растёт кнопкой «Показать ещё». */
  limit?: number;
}

const PAGE = 200;

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

let _productsCacheOrders: Order[] | null = null;
let _productsCacheKey = '';
let _productsCacheHtml = '';

export function clearProductsCache(): void {
  _productsCacheOrders = null; _productsCacheKey = ''; _productsCacheHtml = '';
}

export function renderProductsTab(orders: Order[], f: ProductsFilters, periodCosts: PeriodCost[] = [], manual: ManualEntry[] = []): string {
  const key = `${f.sort}|${f.search}|${f.dir ?? -1}|${f.limit ?? PAGE}|${periodCosts.length}|${manual.length}`;
  if (orders === _productsCacheOrders && key === _productsCacheKey && _productsCacheHtml) {
    return _productsCacheHtml;
  }
  const html = _renderProductsTabUncached(orders, f, periodCosts, manual);
  _productsCacheOrders = orders;
  _productsCacheKey = key;
  _productsCacheHtml = html;
  return html;
}

function _renderProductsTabUncached(orders: Order[], f: ProductsFilters, periodCosts: PeriodCost[], manual: ManualEntry[]): string {
  let skus = computeSkuPerformance(orders, periodCosts, manual);
  if (f.search) {
    const q = f.search.toLowerCase();
    skus = skus.filter(s => (s.vendor_code + ' ' + s.name).toLowerCase().includes(q));
  }
  const abc = abcClasses(skus);
  const val: Record<ProductsSort, (x: SkuPerformance) => number> = {
    profit: x => x.net_profit, revenue: x => x.revenue, units: x => x.units_sold, margin: x => x.margin_pct,
    profit_per_unit: x => x.profit_per_unit, returns: x => x.return_rate_pct, cogs: x => x.cogs,
    fees: x => x.commission + x.logistics + x.services + x.tax + x.period_costs + x.manual_costs,
  };
  const dir = f.dir ?? -1;
  const get = val[f.sort] ?? val.profit;
  skus.sort((a, b) => (get(a) - get(b)) * dir);
  const limit = f.limit ?? PAGE;
  const th = (key: ProductsSort, label: string, title = '') => `
    <th class="num an2-sortable ${f.sort === key ? 'active' : ''}" title="${title}" onclick="window.analyticsModule?.sortProducts('${key}')">
      ${label}${f.sort === key ? (dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>`;
  const missingUnits = skus.reduce((s, x) => s + x.missing_cogs_units, 0);

  return `
    <div class="an2-card" style="padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="search" placeholder="Поиск по артикулу/названию…"
          value="${escapeHtml(f.search)}"
          oninput="window.analyticsModule?.setProductsFilter('search', this.value)"
          style="flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border);border-radius:9px;padding:7px 12px;color:var(--text);font-size:12px;outline:none;font-family:inherit"/>
        <div style="font-size:12px;color:var(--text3);margin-left:auto">
          ${fmtNum(skus.length)} SKU · A ${fmtNum([...abc.values()].filter(v => v === 'A').length)} · B ${fmtNum([...abc.values()].filter(v => v === 'B').length)} · C ${fmtNum([...abc.values()].filter(v => v === 'C').length)}
        </div>
      </div>
      <div style="margin-top:8px;font-size:11.5px;color:var(--text3);line-height:1.5">
        Прибыль товара = выручка − комиссия − логистика − услуги − налог − себестоимость − потери по возвратам и отменам − доля общих расходов.
        Сумма прибыли всех товаров равна чистой прибыли в «Сводке». ABC — по выручке: A дают 80% выручки, B — 15%, C — остальное.
        Сортировка — клик по заголовку колонки.
        ${missingUnits ? `<strong style="color:#fbbf24">Не хватает себестоимости для ${fmtNum(missingUnits)} ед.</strong>` : 'Себестоимость заполнена для всех проданных единиц.'}
      </div>
    </div>

    <div class="an2-card" style="padding:0;overflow:hidden">
      ${skus.length === 0 ? `
        <div class="an2-empty">
          <div class="emoji">${I.package('',24)}</div>
          <h3>Нет товаров</h3>
          <p>За выбранный период не было продаж — или фильтр слишком жёсткий.</p>
        </div>
      ` : `
        <div style="overflow-x:auto">
          <table class="an2-table">
            <thead><tr>
              <th>Товар</th>
              <th>МП</th>
              <th title="ABC по выручке">ABC</th>
              ${th('units', 'Продано')}
              ${th('returns', 'Возвраты', 'Доля возвращённых штук')}
              ${th('revenue', 'Выручка')}
              ${th('fees', 'Удержания', 'Комиссия + логистика + услуги + налог + общие расходы')}
              ${th('cogs', 'Себестоимость')}
              ${th('profit_per_unit', 'Прибыль/шт')}
              ${th('profit', 'Прибыль')}
              ${th('margin', 'Маржа')}
              <th class="num" title="Доля проданных штук с заданной себестоимостью">Себест. задана</th>
            </tr></thead>
            <tbody>
              ${skus.slice(0, limit).map(s => {
                const cls = abc.get(`${s.mp}|${s.vendor_code}`) ?? 'C';
                return `
                  <tr>
                    <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                      <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text3)">${escapeHtml(s.vendor_code)}${copyButton(s.vendor_code, 'Копировать артикул')}</div>
                      <div style="display:flex;align-items:center;gap:4px;font-weight:600">${escapeHtml(s.name)}${copyButton(s.name, 'Копировать название')}</div>
                    </td>
                    <td>
                      <span class="mp-badge">
                        <span class="mp-dot" style="background:${MP_COLOR[s.mp]}"></span>${MP_SHORT[s.mp]}
                      </span>
                    </td>
                    <td><span class="an2-abc an2-abc-${cls}">${cls}</span></td>
                    <td class="num">${fmtNum(s.units_sold)}</td>
                    <td class="num ${s.return_rate_pct >= 10 ? 'neg' : ''}">${s.return_rate_pct.toFixed(1)}%</td>
                    <td class="num">${fmtMoney(s.revenue)}</td>
                    <td class="num neg" title="Комиссия + логистика + услуги + налог + общие расходы">${fmtMoney(s.commission + s.logistics + s.services + s.tax + s.period_costs + s.manual_costs)}</td>
                    <td class="num">${fmtMoney(s.cogs)}</td>
                    <td class="num ${s.profit_per_unit >= 0 ? 'pos' : 'neg'}">${fmtMoney(s.profit_per_unit)}</td>
                    <td class="num ${s.net_profit >= 0 ? 'pos' : 'neg'}">${fmtMoney(s.net_profit)}</td>
                    <td class="num">${s.margin_pct.toFixed(1)}%</td>
                    <td class="num ${s.cogs_coverage_pct < 100 ? 'neg' : ''}" title="Доля проданных единиц с заполненной себестоимостью">${s.cogs_coverage_pct.toFixed(0)}%</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
        ${skus.length > limit ? `
          <div style="padding:12px;text-align:center;border-top:1px solid var(--border)">
            <button class="an2-btn ghost" onclick="window.analyticsModule?.showMoreProducts()">
              Показать ещё ${fmtNum(Math.min(PAGE, skus.length - limit))} из ${fmtNum(skus.length - limit)}
            </button>
          </div>` : ''}
      `}
    </div>
  `;
}
