import { I } from '@/utils/icons';
import { MP_LABEL } from '../types';
import type { Mp, UnifiedProduct } from '../types';
import { esc } from '../utils';
import { copyButton } from '@/utils/copyButton';
import type { ProducerCostLink } from '@/services/costProducerLinks';

export interface CostEntry { vendorCode: string; cost: number }

export interface CostsTabProps {
  products: UnifiedProduct[];
  costsSearch: string;
  costsMpFilter: string;
  costsSelected: Set<string>;
  costsBulkValue: string | number;
  soldVendorCodes: Set<string> | null;
  getCost: (vendorCode: string) => number | null | undefined;
  allCostEntries: CostEntry[];
  /** Привязки к производителям: ключ — vendorCode lower. */
  producerLinks: Record<string, ProducerCostLink>;
  /** Артикулы у которых есть доступная себестоимость от производителя (для кнопки «привязать»). */
  producerCostMap: Map<string, { cost: number; producerProductId: string; producerName: string }>;
}

export function renderCosts(p: CostsTabProps): string {
  const catalogKeys = new Set(p.products.map(q => q.vendorCode.trim().toLowerCase()));
  const orphanEntries = p.allCostEntries.filter(e => !catalogKeys.has(e.vendorCode.trim().toLowerCase()));
  const catalogCount = p.products.length;
  const withCost = p.products.filter(pr => p.getCost(pr.vendorCode) != null).length;
  const withoutCost = catalogCount - withCost;
  const pct = catalogCount > 0 ? Math.round(withCost / catalogCount * 100) : 0;

  return `
    <!-- ШАПКА -->
    <div style="padding:16px 20px;background:var(--bg);border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
        <div>
          <div style="font-size:14px;font-weight:800;color:var(--text);margin-bottom:3px">Себестоимости товаров</div>
          <div style="font-size:11px;color:var(--text2)">
            Используется в правилах <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">По марже</code>
            и <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">Формула</code>
            как переменная <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">cost_price</code>
          </div>
        </div>
        <div style="display:flex;gap:7px;flex-shrink:0">
          <button class="rpr-btn rpr-btn-ghost" onclick="window.repricerModule.exportCostsTemplate()">↓ xlsx</button>
          <label class="rpr-btn rpr-btn-ghost" style="cursor:pointer">
            ↑ Импорт
            <input type="file" accept=".xlsx,.xls" style="display:none" onchange="window.repricerModule.importCostsFile(this)">
          </label>
        </div>
      </div>

      <!-- KPI -->
      <div class="rpr-stats">
        <div class="rpr-stat">
          <div class="rpr-stat-label">В каталоге</div>
          <div class="rpr-stat-val">${catalogCount}</div>
        </div>
        <div class="rpr-stat">
          <div class="rpr-stat-label" style="color:#22c55e">С cost_price</div>
          <div class="rpr-stat-val green">${withCost}</div>
        </div>
        <div class="rpr-stat ${withoutCost > 0 ? '' : ''}" style="${withoutCost > 0 ? 'border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.04)' : ''}">
          <div class="rpr-stat-label" style="${withoutCost > 0 ? 'color:#ef4444' : ''}">Без cost_price</div>
          <div class="rpr-stat-val ${withoutCost > 0 ? 'red' : ''}">${withoutCost}</div>
        </div>
        ${renderOrphanStats(orphanEntries, p.soldVendorCodes)}
      </div>

      <!-- Прогресс-бар -->
      ${catalogCount > 0 ? `
        <div style="margin-top:12px">
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-bottom:4px">
            <span>Заполненность себестоимости</span>
            <span style="font-weight:700;color:${pct >= 90 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444'}">${pct}%</span>
          </div>
          <div style="height:5px;background:var(--bg3);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${pct >= 90 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444'};border-radius:3px;transition:width .5s"></div>
          </div>
        </div>
      ` : ''}
    </div>

    <!-- РУЧНОЙ ВВОД -->
    <div style="padding:10px 20px;background:var(--bg2);border-bottom:1px solid var(--border)">
      <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
        <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);white-space:nowrap">Добавить вручную:</span>
        <input type="text" id="rp-manual-vc" placeholder="Артикул"
          onkeydown="if(event.key==='Enter')window.repricerModule.addCostManual()"
          style="flex:2;min-width:140px;padding:6px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;font-size:12px;font-family:monospace;outline:none">
        <input type="number" id="rp-manual-cost" placeholder="Себестоимость ₽" min="0" step="1"
          onkeydown="if(event.key==='Enter')window.repricerModule.addCostManual()"
          style="flex:1;min-width:120px;padding:6px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;font-size:12px;outline:none">
        <button class="rpr-btn rpr-btn-green" onclick="window.repricerModule.addCostManual()">Сохранить</button>
        <span style="font-size:10.5px;color:var(--text3)">Для архивных артикулов вне каталога</span>
      </div>
    </div>

    <div id="rpr-costs-host">${renderCostsInner(p)}</div>
  `;
}

/** Только фильтры + таблица — обновляется при поиске без потери фокуса на поле ввода. */
export function renderCostsInner(p: CostsTabProps): string {
  const catalogKeys = new Set(p.products.map(q => q.vendorCode.trim().toLowerCase()));
  const orphanEntries = p.allCostEntries.filter(e => !catalogKeys.has(e.vendorCode.trim().toLowerCase()));

  type Row = { vendorCode: string; title: string; variants: UnifiedProduct['variants']; orphan: boolean };
  const allRows: Row[] = [
    ...p.products.map(q => ({ vendorCode: q.vendorCode, title: q.title, variants: q.variants, orphan: false })),
    ...orphanEntries.map(e => ({ vendorCode: e.vendorCode, title: '', variants: [] as UnifiedProduct['variants'], orphan: true })),
  ];

  const q = p.costsSearch.toLowerCase().trim();
  const filtered = allRows.filter(r => {
    if (p.costsMpFilter && !r.orphan && !r.variants.some(v => v.mp === p.costsMpFilter)) return false;
    if (p.costsMpFilter && r.orphan) return false;
    if (q && !`${r.vendorCode} ${r.title}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const allFilteredSelected = filtered.length > 0 && filtered.every(r => p.costsSelected.has(r.vendorCode.toLowerCase()));

  return `
    <!-- ФИЛЬТРЫ + МАССОВАЯ ОПЕРАЦИЯ -->
    <div style="display:flex;align-items:center;gap:7px;padding:10px 20px;background:var(--bg);border-bottom:1px solid var(--border);flex-wrap:wrap">
      <input class="rpr-search" type="search" placeholder="Поиск по артикулу или названию…"
        value="${esc(p.costsSearch)}"
        oninput="window.repricerModule.setCostsSearch(this.value)">
      <select class="rpr-select" onchange="window.repricerModule.setCostsMp(this.value)">
        <option value=""       ${p.costsMpFilter === ''       ? 'selected' : ''}>Все МП</option>
        <option value="wb"     ${p.costsMpFilter === 'wb'     ? 'selected' : ''}>WB</option>
        <option value="ozon"   ${p.costsMpFilter === 'ozon'   ? 'selected' : ''}>Ozon</option>
        <option value="yandex" ${p.costsMpFilter === 'yandex' ? 'selected' : ''}>ЯМ</option>
      </select>
      <button class="rpr-btn ${allFilteredSelected ? 'rpr-btn-green' : 'rpr-btn-ghost'}"
        onclick="window.repricerModule.toggleCostsAll()">
        ${allFilteredSelected ? '✓ Снять все' : `Выбрать (${filtered.length})`}
      </button>
      ${p.costsSelected.size > 0 ? `
        <div style="display:flex;gap:6px;align-items:center;padding:5px 10px;background:rgba(212,240,0,.06);border:1px solid rgba(212,240,0,.2);border-radius:8px">
          <span style="font-size:11px;color:var(--text2)">${p.costsSelected.size} шт → </span>
          <input type="number" id="rp-bulk-cost" placeholder="₽" min="0" step="1" value="${p.costsBulkValue}"
            style="width:75px;padding:4px 7px;border:1px solid var(--border);background:var(--bg3);color:var(--text);border-radius:5px;font-size:12px;outline:none">
          <button class="rpr-btn rpr-btn-green" style="padding:4px 10px;font-size:11px"
            onclick="window.repricerModule.applyCostsBulk()">Применить</button>
        </div>
      ` : ''}
      <span style="font-size:11px;color:var(--text3);margin-left:auto">${filtered.length} из ${allRows.length}</span>
    </div>

    <!-- ТАБЛИЦА -->
    <div style="overflow:auto">
      ${filtered.length === 0 ? `
        <div class="rpr-empty">
          <div class="rpr-empty-icon">${I.search()}</div>
          <h3>Ничего не найдено</h3>
          <p>Попробуй изменить фильтр.</p>
        </div>
      ` : `
        <table class="rpr-table">
          <thead>
            <tr>
              <th style="width:36px;padding:9px 16px"></th>
              <th>Артикул</th>
              <th>Название / статус</th>
              <th style="text-align:center">МП</th>
              <th class="num">Цена МП</th>
              <th class="num" style="min-width:160px">Себестоимость, ₽</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(r => {
              const sel = p.costsSelected.has(r.vendorCode.toLowerCase());
              const cost = p.getCost(r.vendorCode);
              const prices = r.variants.filter(v => v.price != null).map(v => v.price as number);
              const minP = prices.length ? Math.min(...prices) : null;
              const maxP = prices.length ? Math.max(...prices) : null;
              const vcLower = r.vendorCode.trim().toLowerCase();
              const link = p.producerLinks[vcLower] ?? null;
              const isProducerLinked = !!link;
              const availableFromProducer = !isProducerLinked ? (p.producerCostMap.get(vcLower) ?? null) : null;
              return `
                <tr style="${sel ? 'background:rgba(212,240,0,.04)' : r.orphan ? 'background:rgba(245,158,11,.03)' : ''}">
                  <td style="padding:7px 16px">
                    <div onclick="window.repricerModule.toggleCostsRow('${esc(r.vendorCode)}')"
                      class="rpr-check ${sel ? 'checked' : ''}">
                      ${sel ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="black" stroke-width="2.2"><path d="M2 6l3 3 5-6"/></svg>' : ''}
                    </div>
                  </td>
                  <td style="display:flex;align-items:center;gap:4px;font-family:monospace;font-size:11.5px">${esc(r.vendorCode)}${copyButton(r.vendorCode, 'Копировать артикул')}</td>
                  <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text2)">
                    ${r.orphan ? renderOrphanLabel(r.vendorCode, p.soldVendorCodes) : `<span style="display:inline-flex;align-items:center;gap:4px;max-width:100%">${esc(r.title)}${copyButton(r.title, 'Копировать название')}</span>`}
                  </td>
                  <td style="text-align:center">
                    <div style="display:flex;justify-content:center;gap:2px">
                      ${r.orphan
                        ? renderOrphanMpLabel(r.vendorCode, p.soldVendorCodes)
                        : r.variants.map(v => `<span class="rpr-mp rpr-mp-${v.mp}">${MP_LABEL[v.mp as Mp]}</span>`).join('')
                      }
                    </div>
                  </td>
                  <td class="num" style="color:var(--text2);font-size:11.5px">
                    ${!r.orphan && minP != null && maxP != null
                      ? (minP === maxP ? `${minP.toLocaleString('ru')} ₽` : `${minP.toLocaleString('ru')}–${maxP.toLocaleString('ru')}`)
                      : '—'}
                  </td>
                  <td style="padding:7px 16px">
                    <div style="display:flex;justify-content:flex-end;align-items:center;gap:5px;flex-wrap:wrap">
                      ${isProducerLinked ? `
                        <span title="Себестоимость привязана к производителю «${esc(link!.producerName)}»"
                          style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;
                            background:rgba(99,102,241,.12);color:#818cf8;font-size:10px;font-weight:600;
                            white-space:nowrap;flex-shrink:0;cursor:default">
                          🔗 ${esc(link!.producerName)}
                        </span>
                      ` : ''}
                      <input type="number" min="0" step="1" value="${cost ?? ''}" placeholder="не задана"
                        onchange="window.repricerModule.setCostWithProducerCheck('${esc(r.vendorCode)}',+this.value)"
                        class="rpr-cost-input ${cost != null ? 'has-value' : 'missing'}">
                      ${availableFromProducer ? `
                        <button onclick="window.repricerModule.relinkFromProducer('${esc(r.vendorCode)}')"
                          title="Привязать себестоимость от производителя: ${availableFromProducer.cost.toLocaleString('ru')} ₽ (${esc(availableFromProducer.producerName)})"
                          style="display:inline-flex;align-items:center;gap:3px;padding:3px 7px;border:1px solid rgba(99,102,241,.35);
                            border-radius:5px;background:rgba(99,102,241,.08);cursor:pointer;color:#818cf8;font-size:10px;
                            font-weight:600;white-space:nowrap;flex-shrink:0">
                          🔗 от производителя
                        </button>
                      ` : ''}
                      ${r.orphan ? `
                        <button onclick="if(confirm('Удалить запись?'))window.repricerModule.setCost('${esc(r.vendorCode)}',NaN)"
                          title="Удалить"
                          style="width:22px;height:22px;border:1px solid rgba(245,158,11,.3);border-radius:4px;background:transparent;
                            cursor:pointer;color:#f59e0b;font-size:12px;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0">✕</button>
                      ` : ''}
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderOrphanStats(
  orphanEntries: CostEntry[],
  soldVendorCodes: Set<string> | null,
): string {
  if (!soldVendorCodes) {
    return `
      <div class="rpr-stat" style="border-color:rgba(245,158,11,.2);background:rgba(245,158,11,.04)">
        <div class="rpr-stat-label" style="color:#f59e0b">Вне каталога</div>
        <div class="rpr-stat-val amber">${orphanEntries.length}</div>
        <div style="font-size:9px;color:var(--text3);margin-top:3px">проверяем…</div>
      </div>`;
  }
  const archived = orphanEntries.filter(e => soldVendorCodes.has(e.vendorCode.trim().toLowerCase())).length;
  const deleted = orphanEntries.length - archived;
  return `
    <div class="rpr-stat" style="border-color:rgba(245,158,11,.2);background:rgba(245,158,11,.04)">
      <div class="rpr-stat-label" style="color:#f59e0b">Архив</div>
      <div class="rpr-stat-val amber">${archived}</div>
      <div style="font-size:9.5px;color:var(--text3);margin-top:3px">был в продажах</div>
    </div>
    ${deleted > 0 ? `
      <div class="rpr-stat" style="border-color:rgba(239,68,68,.2);background:rgba(239,68,68,.04)">
        <div class="rpr-stat-label" style="color:#ef4444">Удалён</div>
        <div class="rpr-stat-val red">${deleted}</div>
        <button onclick="window.repricerModule.deleteAllDeletedCosts()"
          style="margin-top:4px;padding:2px 8px;border:1px solid rgba(239,68,68,.3);background:transparent;
            color:#ef4444;border-radius:4px;cursor:pointer;font-size:9.5px;font-family:inherit;font-weight:600">
          Удалить все →
        </button>
      </div>
    ` : ''}
  `;
}

function renderOrphanLabel(vendorCode: string, soldVendorCodes: Set<string> | null): string {
  if (!soldVendorCodes) {
    return `<span style="font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(120,120,120,.1);color:var(--text3);font-weight:700">проверяем…</span>`;
  }
  const wasSold = soldVendorCodes.has(vendorCode.trim().toLowerCase());
  return wasSold
    ? `<span style="font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(245,158,11,.12);color:#f59e0b;font-weight:700">архив</span>`
    : `<span style="font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(239,68,68,.12);color:#ef4444;font-weight:700">удалён</span>`;
}

function renderOrphanMpLabel(vendorCode: string, soldVendorCodes: Set<string> | null): string {
  if (!soldVendorCodes) {
    return `<span style="font-size:9px;color:var(--text3)">—</span>`;
  }
  const wasSold = soldVendorCodes.has(vendorCode.trim().toLowerCase());
  return wasSold
    ? `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(245,158,11,.1);color:#f59e0b">был в продажах</span>`
    : `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,.08);color:#ef4444">не продавался</span>`;
}
