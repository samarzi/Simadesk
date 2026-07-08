/** Пикер товаров: выбор одного или нескольких артикулов из всех МП для правила репрайсера. */

import { I } from '@/utils/icons';
import { MP_BG, MP_COLOR, MP_LABEL } from '../types';
import type { Mp, UnifiedProduct } from '../types';
import { esc } from '../utils';
import { copyButton } from '@/utils/copyButton';

export interface ProductPickerProps {
  /** Отфильтрованный список товаров (см. RepricerModule.pickerFiltered). */
  list: UnifiedProduct[];
  /** Общее количество объединённых товаров (без фильтров). */
  allCount: number;
  pickerSelected: Set<string>;
  pickerSearch: string;
  pickerSelectedMps: Set<Mp>;
  pickerSelectedStores: Set<string>;
  pickerStockFilter: 'all' | 'in' | 'out';
  /** Магазины для отображения в фильтре (см. RepricerModule.storesForPicker). */
  pickerStores: Array<{ id: string; name: string; mp: Mp }>;
  hasWb: boolean;
  hasOzon: boolean;
  hasYandex: boolean;
}

/** HTML пикера. Возвращает только инкапсулированный <div>-контент (без overlay-обёртки). */
export function renderPicker(p: ProductPickerProps): string {
  const { list, allCount, pickerSelected, pickerSearch, pickerSelectedMps, pickerSelectedStores, pickerStockFilter, pickerStores } = p;
  const allSelected = list.length > 0 && list.every(prod => pickerSelected.has(prod.vendorCode.toLowerCase()));

  const mpChip = (mp: Mp, label: string) => {
    const on = pickerSelectedMps.has(mp);
    return `<button onclick="window.repricerModule.togglePickerMp('${mp}')"
      style="padding:5px 13px;border:1.5px solid ${on ? MP_COLOR[mp] : 'var(--border)'};
        background:${on ? MP_BG[mp] : 'var(--bg)'};color:${on ? MP_COLOR[mp] : 'var(--text2)'};
        border-radius:20px;cursor:pointer;font-size:12px;font-weight:${on ? '700' : '500'};transition:all .12s">
      ${on ? '✓ ' : ''}${label}
    </button>`;
  };

  const storeChip = (s: { id: string; name: string; mp: Mp }) => {
    const on = pickerSelectedStores.has(s.id);
    return `<button onclick="window.repricerModule.togglePickerStore('${esc(s.id)}')" title="${esc(s.name)}"
      style="padding:5px 13px;border:1.5px solid ${on ? MP_COLOR[s.mp] : 'var(--border)'};
        background:${on ? MP_BG[s.mp] : 'var(--bg)'};color:${on ? MP_COLOR[s.mp] : 'var(--text2)'};
        border-radius:20px;cursor:pointer;font-size:12px;font-weight:${on ? '700' : '500'};
        max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:all .12s">
      ${on ? '✓ ' : ''}${esc(s.name)}
    </button>`;
  };

  return `
    <!-- ПОИСК + ОСТАТОК -->
    <div style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap">
      <input type="search" placeholder="Поиск по артикулу или названию…" value="${esc(pickerSearch)}"
        oninput="window.repricerModule.setPickerSearch(this.value)"
        style="flex:1;min-width:180px;padding:7px 12px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:13px">
      <select onchange="window.repricerModule.setPickerStock(this.value)"
        style="padding:7px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:12px">
        <option value="all" ${pickerStockFilter === 'all' ? 'selected' : ''}>Любой остаток</option>
        <option value="in"  ${pickerStockFilter === 'in'  ? 'selected' : ''}>В наличии</option>
        <option value="out" ${pickerStockFilter === 'out' ? 'selected' : ''}>Закончился</option>
      </select>
      <button onclick="window.repricerModule.togglePickerAll()"
        style="padding:7px 14px;border:1px solid var(--accent);background:${allSelected ? 'var(--accent)' : 'transparent'};color:${allSelected ? '#000' : 'var(--accent)'};border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">
        ${allSelected ? '✓ Снять все' : 'Выбрать все'}
      </button>
    </div>

    <!-- МАРКЕТПЛЕЙСЫ (кнопки-чипы) -->
    <div style="padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:7px">
        Маркетплейс
        ${pickerSelectedMps.size > 0 ? `<button onclick="window.repricerModule.clearPickerMps()" style="margin-left:8px;font-size:10px;color:var(--text2);background:none;border:none;cursor:pointer;text-decoration:underline">сбросить</button>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${p.hasWb ? mpChip('wb', 'Wildberries') : ''}
        ${p.hasOzon ? mpChip('ozon', 'Ozon') : ''}
        ${p.hasYandex ? mpChip('yandex', 'Я.Маркет') : ''}
        ${(!p.hasWb && !p.hasOzon && !p.hasYandex)
          ? '<span style="font-size:12px;color:var(--text2)">Нет подключённых магазинов</span>' : ''}
      </div>
    </div>

    <!-- МАГАЗИНЫ (кнопки-чипы, сгруппированы по МП) -->
    ${pickerStores.length > 0 ? `
      <div style="padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg2)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">
            Магазин (правила создадутся для выбранных)
          </div>
          ${pickerSelectedStores.size > 0 ? `
            <button onclick="window.repricerModule.clearPickerStores()"
              style="font-size:10px;color:var(--text2);background:none;border:none;cursor:pointer;text-decoration:underline">Сбросить (${pickerSelectedStores.size})</button>
          ` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${pickerStores.map(s => storeChip(s)).join('')}
        </div>
        ${pickerSelectedStores.size === 0 ? `
          <div style="margin-top:6px;font-size:10.5px;color:var(--text2)">
            ${I.lightbulb()} Не выбраны = правила создадутся для всех магазинов выбранного МП
          </div>
        ` : `
          <div style="margin-top:6px;font-size:10.5px;color:#059669;font-weight:600">
            ✓ Правила создадутся только для выбранных магазинов (${pickerSelectedStores.size} шт)
          </div>
        `}
      </div>
    ` : ''}

    <!-- СТАТИСТИКА -->
    <div style="padding:7px 16px;font-size:11px;color:var(--text2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px;background:var(--bg2)">
      <span>Показано <b style="color:var(--text)">${list.length}</b> из ${allCount}</span>
      <span>Выбрано товаров: <b style="color:var(--accent)">${pickerSelected.size}</b></span>
    </div>

    <!-- СПИСОК ТОВАРОВ -->
    <div style="flex:1;overflow-y:auto;min-height:0;padding-bottom:90px">
      ${list.length === 0 ? `
        <div style="padding:40px;text-align:center;color:var(--text2);font-size:13px">
          Ничего не найдено · попробуйте изменить фильтры
        </div>
      ` : list.map(prod => {
        const sel = pickerSelected.has(prod.vendorCode.toLowerCase());
        const totalStock = prod.variants.reduce((s,v) => s+v.stock, 0);
        const prices = prod.variants.filter(v => v.price != null).map(v => v.price!);
        const minP = prices.length ? Math.min(...prices) : null;
        const maxP = prices.length ? Math.max(...prices) : null;
        // Показываем только варианты из выбранных магазинов (или все)
        const visVariants = pickerSelectedStores.size > 0
          ? prod.variants.filter(v => pickerSelectedStores.has(v.storeId))
          : pickerSelectedMps.size > 0
            ? prod.variants.filter(v => pickerSelectedMps.has(v.mp))
            : prod.variants;
        return `
          <div onclick="window.repricerModule.togglePickerItem('${esc(prod.vendorCode)}')"
            style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer;
              background:${sel ? 'color-mix(in srgb,var(--accent) 8%,transparent)' : 'transparent'};transition:background .1s">
            <div style="width:20px;height:20px;border:1.5px solid ${sel ? 'var(--accent)' : 'var(--border)'};border-radius:5px;
              background:${sel ? 'var(--accent)' : 'transparent'};flex-shrink:0;display:flex;align-items:center;justify-content:center">
              ${sel ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#000" stroke-width="2"><path d="M2 6l3 3 5-6"/></svg>' : ''}
            </div>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:4px;font-size:13px;font-weight:600;color:var(--text)">
                <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(prod.title)}</span>${copyButton(prod.title, 'Копировать название')}
              </div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap">
                <span style="font-family:monospace;font-size:10.5px;color:var(--text2);background:var(--bg3);padding:1px 6px;border-radius:4px">${esc(prod.vendorCode)}</span>${copyButton(prod.vendorCode, 'Копировать артикул')}
                ${visVariants.map(v => `
                  <span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;background:${MP_BG[v.mp]};color:${MP_COLOR[v.mp]}">
                    ${MP_LABEL[v.mp]}${v.storeName ? ' · ' + esc(v.storeName) : ''}
                  </span>
                `).join('')}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:13px;font-weight:700;color:${minP ? 'var(--text)' : 'var(--text2)'}">
                ${minP != null && maxP != null ? (minP === maxP ? `${minP.toLocaleString('ru')} ₽` : `${minP.toLocaleString('ru')}–${maxP.toLocaleString('ru')} ₽`) : '—'}
              </div>
              <div style="font-size:11px;color:${totalStock > 0 ? '#16a34a' : '#dc2626'};margin-top:2px">${totalStock} шт</div>
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <!-- ФУТЕР -->
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-top:1px solid var(--border);background:var(--bg2)">
      <div style="font-size:12px;color:var(--text2)">
        ${pickerSelected.size > 1
          ? `<b style="color:#059669">${pickerSelected.size} товаров</b> будут добавлены в одно правило`
          : pickerSelected.size === 1
            ? 'Товар будет выбран в форме'
            : 'Выберите один или несколько товаров'}
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="window.repricerModule.closeProductPicker()"
          style="padding:8px 18px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;cursor:pointer;font-size:13px">Отмена</button>
        <button onclick="window.repricerModule.applyPickerSelection()" ${pickerSelected.size === 0 ? 'disabled' : ''}
          style="padding:8px 20px;border:none;background:var(--accent);color:#0a0a0a;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;opacity:${pickerSelected.size === 0 ? '.5' : '1'}">
          ${pickerSelected.size > 1 ? `Добавить ${pickerSelected.size} товаров` : 'Выбрать'}
        </button>
      </div>
    </div>
  `;
}

/** Overlay-обёртка пикера (модальное окно). */
export function renderPickerOverlay(content: string): string {
  return `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px"
      onclick="if(event.target===this)window.repricerModule.closeProductPicker()">
      <div style="background:var(--bg);border-radius:14px;width:100%;max-width:820px;max-height:88vh;display:flex;flex-direction:column;
        box-shadow:0 24px 64px rgba(0,0,0,.4);overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:16px;font-weight:700;color:var(--text)">Выбор товара</div>
            <div style="font-size:11px;color:var(--text2);margin-top:2px">
              Товары из выбранных магазинов · одинаковый артикул = одна позиция
            </div>
          </div>
          <button onclick="window.repricerModule.closeProductPicker()" title="Закрыть"
            style="width:32px;height:32px;border:none;background:var(--bg2);color:var(--text);border-radius:8px;cursor:pointer;font-size:14px">✕</button>
        </div>
        <div id="rp-picker-host" style="flex:1;display:flex;flex-direction:column;min-height:0">
          ${content}
        </div>
      </div>
    </div>
  `;
}
