/** Форма создания/редактирования правила репрайсера (мастер из 3 шагов). */

import { I } from '@/utils/icons';
import { MP_BG, MP_COLOR, MP_LABEL, RULE_DESCRIPTIONS, RULE_LABELS } from '../types';
import type { Mp, RepricerRule, RuleType, SchedulePeriod } from '../types';
import { esc, evalFormula } from '../utils';
import { copyButton } from '@/utils/copyButton';

export interface RuleFormProps {
  form: Partial<RepricerRule>;
  formProducts: RepricerRule['products'];
  formStoreIds: Set<string>;
  formStoreFormulas: Map<string, string>;
  editId: string | null;
  formError: string;
  allStores: Array<{ id: string; name: string; mp: Mp }>;
  getCost: (vendorCode: string) => number | null | undefined;
  /** Готовый HTML overlay-пикера товаров, или '' если пикер закрыт. */
  pickerOverlay: string;
}

export function renderForm(p: RuleFormProps): string {
  const f = p.form;
  const formProducts = p.formProducts ?? [];
  const productSelected = formProducts.length > 0 || (!!f.productId && !!f.vendorCode);
  const prodCount = formProducts.length;

  return `
    <div style="padding:16px 24px">

      <!-- ШАГ 1: ТИП ПРАВИЛА -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:10px">
          Шаг 1 — Тип правила
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">
          ${(Object.keys(RULE_LABELS) as RuleType[]).map(rt => {
            const isActive = (f.type ?? 'target') === rt;
            return `
              <button onclick="window.repricerModule.updateForm('type','${rt}')"
                style="padding:10px;border:1.5px solid ${isActive?'#059669':'var(--border)'};
                  background:${isActive?'#05966915':'var(--bg)'};border-radius:10px;cursor:pointer;text-align:left;transition:all .15s">
                <div style="font-size:12px;font-weight:700;color:${isActive?'#059669':'var(--text)'};margin-bottom:2px">${RULE_LABELS[rt]}</div>
                <div style="font-size:10px;color:var(--text2);line-height:1.3">${RULE_DESCRIPTIONS[rt]}</div>
              </button>`;
          }).join('')}
        </div>
      </div>

      <!-- ШАГ 2: ТОВАР И МАГАЗИНЫ -->
      <div style="background:var(--bg2);border:1.5px solid ${productSelected?'#059669':'var(--border)'};border-radius:12px;padding:14px;margin-bottom:12px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${productSelected?'#059669':'var(--text2)'};margin-bottom:8px">
          Шаг 2 — Товар и магазины
        </div>
        ${productSelected ? `
          <div style="display:flex;align-items:flex-start;gap:12px">
            <div style="flex:1;min-width:0">
              <!-- Список выбранных товаров -->
              <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:6px;max-height:180px;overflow-y:auto">
                ${formProducts.map(prod => `
                  <div style="display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:5px 10px">
                    <span style="flex:1;font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(prod.productTitle)}</span>${copyButton(prod.productTitle, 'Копировать название')}
                    <span style="font-family:monospace;font-size:10px;color:var(--text2);flex-shrink:0">${esc(prod.vendorCode)}</span>${copyButton(prod.vendorCode, 'Копировать артикул')}
                    ${prodCount > 1 ? `<button onclick="window.repricerModule.removeFormProduct('${esc(prod.vendorCode)}')"
                      style="width:20px;height:20px;border:none;background:#fee2e2;color:#dc2626;border-radius:5px;cursor:pointer;font-size:11px;flex-shrink:0;line-height:1" title="Убрать">✕</button>` : ''}
                  </div>
                `).join('')}
              </div>
              ${prodCount > 1 ? `<div style="font-size:11px;color:#059669;font-weight:600">${I.package()} ${prodCount} товаров в одном правиле</div>` : ''}
              <!-- Магазины -->
              <div style="display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap">
                ${p.formStoreIds.size > 0
                  ? [...p.formStoreIds].map(sid => {
                      const st = p.allStores.find(s => s.id === sid);
                      return st ? `<span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;background:${MP_BG[st.mp]};color:${MP_COLOR[st.mp]}">${MP_LABEL[st.mp]} · ${esc(st.name)}</span>` : '';
                    }).join('')
                  : `<span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;background:${MP_BG[(f.marketplace??'wb') as Mp]};color:${MP_COLOR[(f.marketplace??'wb') as Mp]}">${MP_LABEL[(f.marketplace??'wb') as Mp]} · ${esc(f.storeName||'')}</span>`
                }
              </div>
            </div>
            <button onclick="window.repricerModule.openProductPicker()"
              style="padding:7px 12px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;cursor:pointer;font-size:11px;flex-shrink:0">
              ↻ ${prodCount > 1 ? 'Изменить' : 'Сменить'}
            </button>
          </div>
        ` : `
          <button onclick="window.repricerModule.openProductPicker()"
            style="width:100%;padding:14px;border:2px dashed var(--accent);background:var(--bg);color:var(--accent);
              border-radius:10px;cursor:pointer;font-size:13px;font-weight:500;
              display:flex;align-items:center;justify-content:center;gap:8px">
            <span style="font-size:18px">${I.package()}</span>
            <span>Выбрать товар и магазины</span>
          </button>
        `}
      </div>

      <!-- ШАГ 3: ПАРАМЕТРЫ -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px;opacity:${productSelected?1:.45};${!productSelected?'pointer-events:none':''}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Шаг 3 — Параметры ${!productSelected ? '<span style="font-weight:400;text-transform:none;font-size:11px">· сначала выберите товар</span>' : ''}</div>
          <select onchange="window.repricerModule.updateForm('status',this.value)"
            style="padding:4px 8px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;font-size:11px">
            <option value="active" ${f.status==='active'?'selected':''}>● Активно</option>
            <option value="paused" ${f.status==='paused'?'selected':''}>○ Пауза</option>
          </select>
        </div>
        ${renderFormFields(p)}
      </div>

      ${p.formError ? `<div style="font-size:13px;color:#dc2626;padding:10px 14px;background:#dc262610;border:1px solid #dc262630;border-radius:8px;margin-bottom:10px">⚠ ${p.formError}</div>` : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="window.repricerModule.closeForm()"
          style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;font-size:13px">
          Отмена
        </button>
        <button onclick="window.repricerModule.saveForm()" ${!productSelected?'disabled':''}
          style="padding:8px 20px;border-radius:8px;border:none;background:${productSelected?'var(--accent)':'#94a3b8'};
            color:#000;cursor:${productSelected?'pointer':'default'};font-size:13px;font-weight:700">
          ${p.editId
            ? '✓ Сохранить'
            : (prodCount > 1 ? `✓ Создать правило (${prodCount} товаров)` : '✓ Создать правило')}
        </button>
      </div>
    </div>

    ${p.pickerOverlay}
  `;
}

function numInput(key: string, label: string, val: any, ph = ''): string {
  // onchange (не oninput) — срабатывает только при потере фокуса или Enter,
  // что не вызывает перерисовку формы при каждом нажатии клавиши
  return `<div>
    <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">${label}</div>
    <input type="number" id="ri-${key}" value="${val ?? ''}" placeholder="${ph}"
      onchange="window.repricerModule.updateForm('${key}',+this.value)"
      style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;
        background:var(--bg);color:var(--text-1);font-size:13px;box-sizing:border-box">
  </div>`;
}

function renderFormFields(p: RuleFormProps): string {
  const f = p.form;
  const formProducts = p.formProducts ?? [];

  if (f.type === 'target') return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:14px">
      ${numInput('targetPrice','Целевая цена, ₽',f.targetPrice,'9 990')}
      ${numInput('minPrice','Мин. цена, ₽',f.minPrice,'')}
      ${numInput('maxPrice','Макс. цена, ₽',f.maxPrice,'')}
    </div>`;

  if (f.type === 'margin') {
    const cost = p.getCost(f.vendorCode ?? '');
    const calc = cost != null && f.marginMultiplier ? Math.round(cost * f.marginMultiplier) : null;
    return `
    <div style="background:${cost != null ? 'color-mix(in srgb,#16a34a 6%,transparent)' : 'color-mix(in srgb,#f59e0b 8%,transparent)'};
      border:1px solid ${cost != null ? 'color-mix(in srgb,#16a34a 30%,transparent)' : 'color-mix(in srgb,#f59e0b 30%,transparent)'};
      border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;line-height:1.5;color:var(--text)">
      ${cost != null
        ? `✓ Себестоимость для <b>${esc(f.vendorCode ?? '')}</b> взята из БД: <b style="color:#16a34a">${cost.toLocaleString('ru')} ₽</b>`
        : `⚠ Себестоимость для <b>${esc(f.vendorCode ?? '—')}</b> не задана. <a href="#" onclick="event.preventDefault();window.repricerModule.setTab('costs')" style="color:#f59e0b;font-weight:600">Перейти в «Себестоимости» →</a>`}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:14px">
      ${numInput('marginMultiplier','Множитель (напр. 2.5)',f.marginMultiplier,'2.5')}
      ${numInput('minPrice','Мин. цена, ₽',f.minPrice,'')}
      ${numInput('maxPrice','Макс. цена, ₽',f.maxPrice,'')}
    </div>
    <div style="font-size:12px;color:var(--text-2);margin-bottom:12px">
      Расчётная цена: <b id="ri-calc-price">${calc != null ? `${calc.toLocaleString('ru')} ₽` : '—'}</b>
    </div>`;
  }

  if (f.type === 'stock') {
    // Если ещё нет tiers — мигрируем из legacy полей или создаём один пустой
    if (!f.stockTiers || f.stockTiers.length === 0) {
      if (f.stockThreshold && f.highStockPrice && f.lowStockPrice) {
        f.stockTiers = [
          { maxStock: f.stockThreshold, price: f.highStockPrice },
          { maxStock: 99999, price: f.lowStockPrice },
        ];
      } else {
        f.stockTiers = [{ maxStock: 10, price: 0 }];
      }
    }
    return `
    <div style="font-size:12px;color:var(--text-2);margin-bottom:10px;background:color-mix(in srgb,#005bff 6%,transparent);
      border:1px solid color-mix(in srgb,#005bff 22%,transparent);border-radius:8px;padding:10px 12px;line-height:1.5">
      ${I.lightbulb()} Правила проверяются <b>по порядку сверху вниз</b>. Берётся первый порог, под который попадает остаток.
      <br>Пример: «≤ 5 шт → 15 000 ₽», «≤ 20 шт → 12 000 ₽», «∞ → 9 990 ₽» — чем меньше остаток, тем выше цена.
    </div>
    <div id="ri-stock-tiers" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px">
      ${f.stockTiers.map((t, i) => `
        <div style="display:grid;grid-template-columns:50px 1fr 1fr 36px;gap:8px;align-items:center;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
          <div style="text-align:center;font-size:11px;color:var(--text2);font-weight:700">${i + 1}</div>
          <div>
            <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Если остаток ≤</div>
            <input type="number" value="${t.maxStock}" min="0" step="1"
              onchange="window.repricerModule.updateStockTier(${i},'maxStock',+this.value)"
              style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;font-size:13px">
          </div>
          <div>
            <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Цена, ₽</div>
            <input type="number" value="${t.price}" min="0" step="1"
              onchange="window.repricerModule.updateStockTier(${i},'price',+this.value)"
              style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;font-size:13px">
          </div>
          <button onclick="window.repricerModule.removeStockTier(${i})" title="Удалить"
            style="width:32px;height:32px;border:1px solid #dc262644;background:#dc262615;color:#dc2626;border-radius:6px;cursor:pointer">✕</button>
        </div>
      `).join('')}
    </div>
    <button onclick="window.repricerModule.addStockTier()"
      style="padding:7px 14px;border:1px dashed var(--accent);background:transparent;color:var(--accent);border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;margin-bottom:10px">
      + Добавить порог
    </button>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:14px">
      ${numInput('minPrice','Глобальный мин., ₽',f.minPrice,'')}
      ${numInput('maxPrice','Глобальный макс., ₽',f.maxPrice,'')}
    </div>`;
  }

  if (f.type === 'schedule') {
    if (!f.schedulePeriods || f.schedulePeriods.length === 0) {
      // Миграция из legacy weekday/weekend
      const ps: SchedulePeriod[] = [];
      if (f.weekdayPrice) ps.push({ days: [1,2,3,4,5], fromTime: '00:00', toTime: '23:59', price: f.weekdayPrice });
      if (f.weekendPrice) ps.push({ days: [0,6], fromTime: '00:00', toTime: '23:59', price: f.weekendPrice });
      f.schedulePeriods = ps.length ? ps : [{ days: [1,2,3,4,5], fromTime: '09:00', toTime: '18:00', price: 0 }];
    }
    const DAYS = ['вс','пн','вт','ср','чт','пт','сб'];
    return `
    <div style="font-size:12px;color:var(--text-2);margin-bottom:10px;background:color-mix(in srgb,#7c3aed 8%,transparent);
      border:1px solid color-mix(in srgb,#7c3aed 22%,transparent);border-radius:8px;padding:10px 12px;line-height:1.5">
      ${I.lightbulb()} Каждый период — это «когда → какая цена». Можно настроить разные цены на разное время дня и дни недели.
      <br>Пример: «Будни 09:00–18:00 → 12 000 ₽», «Будни 18:00–23:59 → 9 990 ₽», «Выходные → 14 990 ₽».
    </div>
    <div id="ri-schedule-periods" style="display:flex;flex-direction:column;gap:10px;margin-bottom:10px">
      ${f.schedulePeriods.map((period, i) => `
        <div style="padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-size:11px;font-weight:700;color:var(--text)">Период #${i + 1}</div>
            <button onclick="window.repricerModule.removeSchedulePeriod(${i})" title="Удалить"
              style="width:26px;height:26px;border:1px solid #dc262644;background:#dc262615;color:#dc2626;border-radius:5px;cursor:pointer;font-size:11px">✕</button>
          </div>
          <div style="font-size:10px;color:var(--text2);margin-bottom:4px">Дни недели</div>
          <div style="display:flex;gap:3px;margin-bottom:10px">
            ${DAYS.map((d, di) => {
              const isOn = period.days.includes(di);
              return `<button onclick="window.repricerModule.toggleScheduleDay(${i},${di})"
                style="flex:1;padding:6px 4px;border:1.5px solid ${isOn ? '#7c3aed' : 'var(--border)'};
                  background:${isOn ? '#7c3aed' : 'var(--bg2)'};color:${isOn ? '#fff' : 'var(--text2)'};
                  border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;text-transform:uppercase">${d}</button>`;
            }).join('')}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1.4fr;gap:8px;align-items:end">
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">С</div>
              <input type="time" value="${period.fromTime}"
                onchange="window.repricerModule.updateSchedulePeriod(${i},'fromTime',this.value)"
                style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:6px;font-size:13px">
            </div>
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">До</div>
              <input type="time" value="${period.toTime}"
                onchange="window.repricerModule.updateSchedulePeriod(${i},'toTime',this.value)"
                style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:6px;font-size:13px">
            </div>
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Цена в этот период, ₽</div>
              <input type="number" value="${period.price}" min="0" step="1" placeholder="9 990"
                onchange="window.repricerModule.updateSchedulePeriod(${i},'price',+this.value)"
                style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:6px;font-size:13px">
            </div>
          </div>
        </div>
      `).join('')}
    </div>
    <button onclick="window.repricerModule.addSchedulePeriod()"
      style="padding:7px 14px;border:1px dashed #7c3aed;background:transparent;color:#7c3aed;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;margin-bottom:10px">
      + Добавить период
    </button>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:14px">
      ${numInput('minPrice','Глобальный мин., ₽',f.minPrice,'')}
      ${numInput('maxPrice','Глобальный макс., ₽',f.maxPrice,'')}
    </div>`;
  }

  if (f.type === 'formula') {
    // Собираем список магазинов из выбранных товаров/formStoreIds
    const formulaStores = p.allStores.filter(s => p.formStoreIds.has(s.id));
    // Если редактирование и магазин один — добавляем его в список
    if (formulaStores.length === 0 && f.storeId) {
      const st = p.allStores.find(s => s.id === f.storeId);
      if (st) formulaStores.push(st);
    }

    const varBtn = (t: string) => `<button onclick="window.repricerModule.insertFormulaToken('${t}')"
      style="padding:5px 9px;border:1px solid #059669;background:#05966910;color:#059669;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;font-family:monospace">${t}</button>`;
    const opBtn  = (t: string, disp?: string) => `<button onclick="window.repricerModule.insertFormulaToken('${t}')"
      style="padding:5px 9px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;font-family:monospace">${disp ?? t}</button>`;

    return `
      <div style="background:color-mix(in srgb,#059669 6%,transparent);border:1px solid color-mix(in srgb,#059669 22%,transparent);
        border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:12px;line-height:1.7;color:var(--text)">
        Формула рассчитывает цену из переменных: <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">cost_price</code> (себестоимость из БД),
        <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">stock</code> (остаток), <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">margin</code> (множитель).<br>
        <b>Для каждого магазина пишется своя формула</b> — разные наценки для WB и Ozon задаются отдельно.
      </div>

      <!-- Быстрая вставка -->
      <div style="margin-bottom:12px">
        <div style="font-size:10px;font-weight:600;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Переменные и операции</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center">
          ${varBtn('cost_price')} ${varBtn('stock')} ${varBtn('margin')}
          <span style="width:1px;height:20px;background:var(--border);margin:0 2px"></span>
          ${opBtn('+')} ${opBtn('-')} ${opBtn('*','×')} ${opBtn('/','÷')} ${opBtn('(')} ${opBtn(')')}
          <span style="width:1px;height:20px;background:var(--border);margin:0 2px"></span>
          ${['1','2','3'].map(n => opBtn(n)).join('')}<span style="font-size:11px;color:var(--text3)">…</span>
        </div>
      </div>

      ${formulaStores.length === 0 ? `
        <div style="padding:20px;text-align:center;background:var(--bg2);border:1px dashed var(--border);border-radius:10px;color:var(--text2);font-size:13px">
          Сначала выберите товары (шаг 2) — магазины подтянутся автоматически
        </div>
      ` : `
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:8px">
          Формула для каждого магазина
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
          ${formulaStores.map(store => {
            const storeFormula = p.formStoreFormulas.get(store.id) ?? (formulaStores.length === 1 ? (f.formula ?? '') : '');
            const cost = (() => {
              const anyProd = p.formProducts?.[0];
              return anyProd ? p.getCost(anyProd.vendorCode) : null;
            })();
            const preview = storeFormula ? evalFormula(storeFormula, { cost_price: cost ?? 0, stock: 0, margin: f.marginMultiplier ?? 1 }) : null;
            return `
              <div style="background:var(--bg);border:1px solid ${storeFormula ? 'color-mix(in srgb,#059669 40%,transparent)' : 'var(--border)'};border-radius:10px;padding:12px">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                  <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;background:${MP_BG[store.mp]};color:${MP_COLOR[store.mp]}">${MP_LABEL[store.mp]}</span>
                  <span style="font-size:12px;font-weight:600;color:var(--text)">${esc(store.name)}</span>
                  ${cost != null ? `<span style="font-size:10px;color:var(--text2);margin-left:auto">cost_price = <b style="color:#16a34a">${cost.toLocaleString('ru')} ₽</b></span>` : `<span style="font-size:10px;color:#f59e0b;margin-left:auto">⚠ cost_price не задан</span>`}
                </div>
                <textarea rows="2" placeholder="cost_price * 2"
                  oninput="window.repricerModule.updateStoreFormula('${esc(store.id)}', this.value)"
                  style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:7px;background:var(--bg2);color:var(--text);
                    font-family:monospace;font-size:14px;resize:vertical;box-sizing:border-box;outline:none">${esc(storeFormula)}</textarea>
                ${preview != null ? `
                  <div style="margin-top:5px;font-size:11px;color:var(--text2)">
                    Результат: <b style="color:#16a34a">${Math.round(preview).toLocaleString('ru')} ₽</b>
                    <span style="opacity:.6">(при cost_price=${cost ?? 0})</span>
                  </div>` : storeFormula ? `<div style="margin-top:5px;font-size:11px;color:#dc2626">⚠ Формула некорректна</div>` : ''}
              </div>`;
          }).join('')}
        </div>
      `}

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px">
        ${numInput('marginMultiplier','margin (доп. множитель)',f.marginMultiplier,'1.87')}
        ${numInput('minPrice','Мин. цена, ₽',f.minPrice,'')}
        ${numInput('maxPrice','Макс. цена, ₽',f.maxPrice,'')}
      </div>
    `;
  }

  if (f.type === 'mrc') {
    const mrcProducts = formProducts.length > 0
      ? formProducts
      : (f.productId && f.vendorCode ? [{ productId: f.productId, vendorCode: f.vendorCode, productTitle: f.productTitle ?? f.productId }] : []);

    return `
    <div style="font-size:12px;color:var(--text-2);margin-bottom:10px;background:color-mix(in srgb,#fc3f1d 6%,transparent);
      border:1px solid color-mix(in srgb,#fc3f1d 22%,transparent);border-radius:8px;padding:10px 12px;line-height:1.5">
      ${I.lightbulb()} Укажите целевую витринную цену (МРЦ) для каждого товара — она будет применена ко всем выбранным маркетплейсам.
      После создания правила цену можно отдельно скорректировать для каждого маркетплейса во вкладке «МРЦ».
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
      ${mrcProducts.map(prod => `
        <div style="display:grid;grid-template-columns:1fr 160px;gap:10px;align-items:center;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
          <div style="overflow:hidden">
            <div style="display:flex;align-items:center;gap:4px;font-size:12px;font-weight:600;color:var(--text)">
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(prod.productTitle)}</span>${copyButton(prod.productTitle, 'Копировать название')}
            </div>
            <div style="display:flex;align-items:center;gap:4px;font-family:monospace;font-size:10px;color:var(--text2)">${esc(prod.vendorCode)}${copyButton(prod.vendorCode, 'Копировать артикул')}</div>
          </div>
          <input type="number" value="${(f as any)['mrcPrice__' + prod.vendorCode] ?? ''}" min="0" step="1" placeholder="МРЦ, ₽"
            onchange="window.repricerModule.updateForm('mrcPrice__${esc(prod.vendorCode)}',+this.value)"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text);font-size:13px;box-sizing:border-box">
        </div>
      `).join('')}
    </div>`;
  }

  return '';
}
