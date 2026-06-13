import { Order, MP_SHORT, MP_COLOR } from '../types';
import { computeSkuPerformance } from '../services/kpiAggregator';
import { fmtMoney, fmtNum, escapeHtml } from '../components/format';

export interface ProductsFilters {
  sort: 'profit' | 'revenue' | 'units' | 'margin';
  search: string;
}

let _productsCacheOrders: Order[] | null = null;
let _productsCacheKey = '';
let _productsCacheHtml = '';

export function clearProductsCache(): void {
  _productsCacheOrders = null; _productsCacheKey = ''; _productsCacheHtml = '';
}

export function renderProductsTab(orders: Order[], f: ProductsFilters): string {
  const key = `${f.sort}|${f.search}`;
  if (orders === _productsCacheOrders && key === _productsCacheKey && _productsCacheHtml) {
    return _productsCacheHtml;
  }
  const html = _renderProductsTabUncached(orders, f);
  _productsCacheOrders = orders;
  _productsCacheKey = key;
  _productsCacheHtml = html;
  return html;
}

function _renderProductsTabUncached(orders: Order[], f: ProductsFilters): string {
  let skus = computeSkuPerformance(orders);
  if (f.search) {
    const q = f.search.toLowerCase();
    skus = skus.filter(s => (s.vendor_code + ' ' + s.name).toLowerCase().includes(q));
  }
  switch (f.sort) {
    case 'profit':  skus.sort((a, b) => b.net_profit - a.net_profit); break;
    case 'revenue': skus.sort((a, b) => b.revenue - a.revenue); break;
    case 'units':   skus.sort((a, b) => b.units_sold - a.units_sold); break;
    case 'margin':  skus.sort((a, b) => b.margin_pct - a.margin_pct); break;
  }

  const totalRev = skus.reduce((s, x) => s + x.revenue, 0);

  return `
    <div class="an2-card" style="padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="search" placeholder="Поиск по артикулу/названию…"
          value="${escapeHtml(f.search)}"
          oninput="window.analyticsModule?.setProductsFilter('search', this.value)"
          style="flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border);border-radius:9px;padding:7px 12px;color:var(--text);font-size:12px;outline:none;font-family:inherit"/>
        <select onchange="window.analyticsModule?.setProductsFilter('sort', this.value)"
          style="background:var(--bg3);border:1px solid var(--border);border-radius:9px;padding:7px 10px;color:var(--text);font-size:12px;font-family:inherit;outline:none">
          <option value="profit"  ${f.sort === 'profit'  ? 'selected' : ''}>По прибыли</option>
          <option value="revenue" ${f.sort === 'revenue' ? 'selected' : ''}>По выручке</option>
          <option value="units"   ${f.sort === 'units'   ? 'selected' : ''}>По продажам</option>
          <option value="margin"  ${f.sort === 'margin'  ? 'selected' : ''}>По марже</option>
        </select>
        <div style="font-size:11px;color:var(--text3);margin-left:auto">${fmtNum(skus.length)} SKU</div>
      </div>
    </div>

    <div class="an2-card" style="padding:0;overflow:hidden">
      ${skus.length === 0 ? `
        <div class="an2-empty">
          <div class="emoji">📦</div>
          <h3>Нет товаров</h3>
          <p>За выбранный период не было продаж — или фильтр слишком жёсткий.</p>
        </div>
      ` : `
        <div style="overflow-x:auto">
          <table class="an2-table">
            <thead><tr>
              <th>Товар</th>
              <th>МП</th>
              <th class="num">Продано</th>
              <th class="num">Выручка</th>
              <th class="num">Комиссия</th>
              <th class="num">Логистика</th>
              <th class="num">COGS</th>
              <th class="num">Прибыль</th>
              <th class="num">Маржа</th>
              <th class="num">% от выр.</th>
            </tr></thead>
            <tbody>
              ${skus.slice(0, 200).map(s => {
                const share = totalRev > 0 ? (s.revenue / totalRev) * 100 : 0;
                return `
                  <tr>
                    <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                      <div style="font-size:10px;color:var(--text3)">${escapeHtml(s.vendor_code)}</div>
                      <div style="font-weight:600">${escapeHtml(s.name)}</div>
                    </td>
                    <td>
                      <span class="mp-badge">
                        <span class="mp-dot" style="background:${MP_COLOR[s.mp]}"></span>${MP_SHORT[s.mp]}
                      </span>
                    </td>
                    <td class="num">${fmtNum(s.units_sold)}</td>
                    <td class="num">${fmtMoney(s.revenue)}</td>
                    <td class="num neg">${fmtMoney(s.commission)}</td>
                    <td class="num neg">${fmtMoney(s.logistics)}</td>
                    <td class="num">${fmtMoney(s.cogs)}</td>
                    <td class="num ${s.net_profit >= 0 ? 'pos' : 'neg'}">${fmtMoney(s.net_profit)}</td>
                    <td class="num">${s.margin_pct.toFixed(1)}%</td>
                    <td class="num" style="color:var(--text3)">${share.toFixed(1)}%</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}
