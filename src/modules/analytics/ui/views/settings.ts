/** Панель настроек аналитики: налоги, реклама Ozon, себестоимость, свои расходы. */

import { StoreInfo, ManualEntry, TaxModel, TAX_LABEL, MP_SHORT } from '../../types';
import { MissingCogsItem } from '../../services/kpiAggregator';
import { rub, num, escapeHtml, jsArg } from '../format';
import { productCell } from '../product';

export type SettingsSection = 'tax' | 'ads' | 'cogs' | 'manual';

export interface SettingsInput {
  section: SettingsSection;
  stores: StoreInfo[];
  manual: ManualEntry[];
  missingCogs: MissingCogsItem[];
  ozon: Array<{ id: string; name: string; perf: boolean }>;
  perfStatus: Map<string, { ok: boolean; text: string }>;
}

const M = 'window.analyticsModule';
const TAX_MODELS: TaxModel[] = ['usn6', 'usn15', 'osn', 'npd', 'patent', 'none'];
const VAT: Array<[number, string]> = [[0, 'без НДС'], [5, '5%'], [7, '7%'], [10, '10%'], [22, '22%']];
const MANUAL_LABEL: Record<string, string> = {
  advertising: 'Реклама', salary: 'Зарплата', rent: 'Аренда', purchase: 'Закупка',
  tax: 'Налог', other_expense: 'Прочий расход', other_income: 'Прочий доход',
};

export function renderSettings(s: SettingsInput): string {
  const tab = (id: SettingsSection, label: string, badge?: number) =>
    `<button class="an-seg ${s.section === id ? 'on' : ''}" onclick="${M}?.setSettingsSection('${id}')">${label}${badge ? ` <span>${badge}</span>` : ''}</button>`;
  return `
    <div class="an-drawer-bg" onclick="${M}?.closeSettings()"></div>
    <aside class="an-drawer wide" role="dialog" aria-label="Настройки аналитики">
      <header>
        <div><h3>Настройки аналитики</h3><div class="an-muted">влияют на расчёт прибыли во всех вкладках</div></div>
        <button class="an-icon" onclick="${M}?.closeSettings()" aria-label="Закрыть">✕</button>
      </header>
      <div class="an-segs an-drawer-tabs">
        ${tab('tax', 'Налоги')}
        ${tab('cogs', 'Себестоимость', s.missingCogs.length)}
        ${s.ozon.length ? tab('ads', 'Реклама Ozon') : ''}
        ${tab('manual', 'Свои расходы')}
      </div>
      <div class="an-drawer-body">
        ${s.section === 'tax' ? taxSection(s) : ''}
        ${s.section === 'cogs' ? cogsSection(s) : ''}
        ${s.section === 'ads' ? adsSection(s) : ''}
        ${s.section === 'manual' ? manualSection(s) : ''}
      </div>
    </aside>`;
}

function taxSection(s: SettingsInput): string {
  return `
    <p class="an-muted">УСН 6%, НПД, патент — налог с выручки. УСН 15% и ОСНО — с прибыли за период (УСН 15%: не меньше 1% выручки).
      НДС: на УСН с 2026 года при выручке больше 20 млн — 5% или 7%; на ОСНО — 22% (входящий НДС с услуг маркетплейса вычитается).</p>
    ${s.stores.length === 0 ? '<div class="an-chart-empty">Нет подключённых магазинов</div>' : s.stores.map(st => `
      <div class="an-setrow">
        <div class="an-setrow-name"><span class="an-mp an-mp-${st.mp}">${MP_SHORT[st.mp]}</span> ${escapeHtml(st.name)}</div>
        <label class="an-field"><span>Режим</span>
          <select onchange="${M}?.setTax('${jsArg(st.id)}','model',this.value)">
            ${TAX_MODELS.map(m => `<option value="${m}" ${st.tax_model === m ? 'selected' : ''}>${TAX_LABEL[m]}</option>`).join('')}
          </select></label>
        <label class="an-field"><span>Ставка</span>
          <input type="number" step="0.1" min="0" max="100" value="${+(st.tax_rate * 100).toFixed(2)}"
            onchange="${M}?.setTax('${jsArg(st.id)}','rate',this.value)"/>%</label>
        <label class="an-field"><span>НДС</span>
          <select onchange="${M}?.setTax('${jsArg(st.id)}','vat',this.value)">
            ${VAT.map(([v, l]) => `<option value="${v}" ${Math.round((st.vat_rate ?? 0) * 100) === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
      </div>`).join('')}`;
}

function cogsSection(s: SettingsInput): string {
  if (!s.missingCogs.length) {
    return `<div class="an-chart-empty good">У всех проданных за период товаров себестоимость задана 👍</div>
      <p class="an-muted">Изменить себестоимость можно в «Репрайсер → Себестоимости». Новая цена действует с момента изменения — прошлые месяцы не пересчитываются.</p>`;
  }
  return `
    <p class="an-muted">Без себестоимости прибыль завышена. Новая цена действует для заказов с сегодняшнего дня, а для более старых заказов — если раньше цены не было.</p>
    ${s.missingCogs.map(m => `
      <form class="an-setrow" onsubmit="event.preventDefault();${M}?.setCostPrice('${jsArg(m.vendor_code)}', this.cost.value)">
        <div class="an-setrow-name">${productCell({ name: m.name, vendor_code: m.vendor_code, mp: m.mp }, { sub: `${num(m.orders_count)} зак.` })}</div>
        <label class="an-field"><input name="cost" type="number" min="0" step="0.01" placeholder="₽ за шт" required/>₽</label>
        <button class="an-btn" type="submit">Сохранить</button>
      </form>`).join('')}`;
}

function adsSection(s: SettingsInput): string {
  return `
    <p class="an-muted">Нужны для точных расходов на рекламу и ДРР. Это <b>отдельные</b> ключи рекламного кабинета:
      performance.ozon.ru → Настройки → API → создать сервисный аккаунт → client_id и client_secret. Ключи Seller API здесь не подходят.</p>
    ${s.ozon.map(st => {
      const stat = s.perfStatus.get(st.id);
      return `
      <div class="an-setblock">
        <div class="an-setrow-name"><span class="an-mp an-mp-ozon">Ozon</span> ${escapeHtml(st.name)}
          <span class="an-pill ${st.perf ? 'ok' : ''}">${st.perf ? 'подключено' : 'не подключено'}</span></div>
        <div class="an-inline">
          <input placeholder="client_id" autocomplete="off" oninput="${M}?.setPerfKey('${jsArg(st.id)}','clientId',this.value)"/>
          <input type="password" placeholder="${st.perf ? 'client_secret сохранён' : 'client_secret'}" autocomplete="new-password"
            oninput="${M}?.setPerfKey('${jsArg(st.id)}','clientSecret',this.value)"/>
          <button class="an-btn" onclick="${M}?.savePerfKeys('${jsArg(st.id)}')">${st.perf ? 'Проверить' : 'Подключить'}</button>
          ${st.perf ? `<button class="an-btn ghost" onclick="${M}?.clearPerfKeys('${jsArg(st.id)}')">Отключить</button>` : ''}
        </div>
        ${stat ? `<div class="an-pill-text ${stat.ok ? 'ok' : 'err'}">${escapeHtml(stat.text)}</div>` : ''}
      </div>`;
    }).join('')}`;
}

function manualSection(s: SettingsInput): string {
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  return `
    <p class="an-muted">Расходы, которых нет в отчётах маркетплейсов: реклама у блогеров, зарплаты, аренда. Попадают в прибыль за свою дату.</p>
    <form class="an-inline" onsubmit="event.preventDefault();${M}?.addManualEntry(this)">
      <input name="description" placeholder="Описание" required/>
      <select name="type">${Object.entries(MANUAL_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <input name="amount" type="number" step="0.01" min="0" placeholder="Сумма ₽" required/>
      <input name="date" type="date" value="${today}" required/>
      <button class="an-btn" type="submit">Добавить</button>
    </form>
    ${s.manual.length === 0 ? '<div class="an-chart-empty">Пока нет записей</div>' : `
      <table class="an-table compact">
        <tbody>${[...s.manual].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50).map(e => `
          <tr>
            <td>${escapeHtml(e.date.slice(0, 10).split('-').reverse().join('.'))}</td>
            <td>${escapeHtml(e.description)}<div class="an-src">${MANUAL_LABEL[e.type] ?? e.type}</div></td>
            <td class="num ${e.type === 'other_income' ? 'pos' : 'neg'}">${e.type === 'other_income' ? '+' : '−'}${rub(e.amount)}</td>
            <td><button class="an-icon" title="Удалить" onclick="${M}?.deleteManualEntry('${jsArg(e.id)}')">✕</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`}`;
}
