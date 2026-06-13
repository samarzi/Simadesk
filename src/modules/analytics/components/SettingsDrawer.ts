import { StoreInfo, ManualEntry, TaxModel, TAX_LABEL, MP_SHORT } from '../types';
import { settingsDb } from '../services/settingsDb';
import { fmtMoney, fmtDate, escapeHtml } from './format';

const TAX_MODELS: TaxModel[] = ['usn6', 'usn15', 'osn', 'npd', 'patent', 'none'];

export function renderSettingsDrawer(stores: StoreInfo[], manual: ManualEntry[], onClose = 'window.analyticsModule?.closeSettings()'): string {
  const s = settingsDb.get();
  return `
    <div class="an2-drawer-backdrop" onclick="${onClose}"></div>
    <div class="an2-drawer" onclick="event.stopPropagation()">
      <div class="an2-drawer-head">
        <div class="an2-drawer-title">
          <div class="id">Настройки Аналитики</div>
          <div class="sub">налоги, курсы валют, ручные расходы</div>
        </div>
        <button class="an2-drawer-close" onclick="${onClose}" aria-label="Закрыть">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="an2-drawer-body">

        <div class="an2-drawer-section">
          <h4>Налог по магазинам</h4>
          <div style="font-size:11px;color:var(--text3);margin-bottom:8px">
            Переопределяет то что указано в настройках магазина. УСН 6 / НПД / Патент = с выручки. УСН 15 / ОСНО = с прибыли.
          </div>
          ${stores.length === 0 ? `
            <div style="padding:20px;text-align:center;color:var(--text3);font-size:11px">нет подключённых магазинов</div>
          ` : stores.map(st => `
            <div class="an2-settings-row">
              <div>
                <div style="font-weight:700;font-size:12px">${escapeHtml(st.name)}</div>
                <div style="font-size:10px;color:var(--text3)">${MP_SHORT[st.mp]}</div>
              </div>
              <select onchange="window.analyticsModule?.setTax('${st.id}','model',this.value)">
                ${TAX_MODELS.map(m => `<option value="${m}" ${st.tax_model === m ? 'selected' : ''}>${TAX_LABEL[m]}</option>`).join('')}
              </select>
              <input type="number" step="0.1" min="0" max="100" value="${(st.tax_rate * 100).toFixed(1)}"
                onchange="window.analyticsModule?.setTax('${st.id}','rate',this.value)"
                placeholder="%"/>
              <button class="an2-btn ghost" onclick="window.analyticsModule?.clearTax('${st.id}')" title="Сбросить">✕</button>
            </div>
          `).join('')}
        </div>

        <div class="an2-drawer-section">
          <h4>Курсы валют (расходы в валюте)</h4>
          ${Object.entries(s.fx_rates).filter(([k]) => k !== 'RUB').map(([cur, rate]) => `
            <div class="an2-settings-row">
              <div style="font-weight:700;font-size:12px">${cur}</div>
              <input type="number" step="0.01" min="0" value="${rate}" onchange="window.analyticsModule?.setFx('${cur}',this.value)" placeholder="₽"/>
              <div></div><div></div>
            </div>
          `).join('')}
        </div>

        <div class="an2-drawer-section">
          <h4>Ручные расходы / доходы</h4>
          <div style="font-size:11px;color:var(--text3);margin-bottom:8px">
            То что не пришло из API: реклама вне ЛК, зарплаты, аренда, разовые расходы.
          </div>
          <form onsubmit="window.analyticsModule?.addManualEntry(event);return false" style="display:grid;grid-template-columns:1fr 110px 100px auto;gap:6px;margin-bottom:10px">
            <input name="description" placeholder="Описание" required
              style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:12px;outline:none;font-family:inherit"/>
            <select name="type" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:12px;font-family:inherit;outline:none">
              <option value="advertising">Реклама</option>
              <option value="salary">Зарплата</option>
              <option value="rent">Аренда</option>
              <option value="purchase">Закупка</option>
              <option value="tax">Налог</option>
              <option value="other_expense">Прочий расход</option>
              <option value="other_income">Прочий доход</option>
            </select>
            <input name="amount" type="number" step="0.01" min="0" placeholder="Сумма ₽" required
              style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:12px;outline:none;font-family:inherit"/>
            <button class="an2-btn" type="submit">+</button>
          </form>
          ${manual.length === 0 ? `
            <div style="padding:16px;text-align:center;color:var(--text3);font-size:11px">пока пусто</div>
          ` : `
            <div>
              ${manual.slice().reverse().slice(0, 30).map(e => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px dashed var(--border)">
                  <div>
                    <div style="font-size:12px;font-weight:600">${escapeHtml(e.description)}</div>
                    <div style="font-size:10px;color:var(--text3)">${e.type} · ${fmtDate(e.date)}</div>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px">
                    <strong style="font-size:12px;color:${e.type === 'other_income' ? 'var(--green)' : 'var(--red)'}">${e.type === 'other_income' ? '+' : '−'}${fmtMoney(e.amount, false)} ₽</strong>
                    <button class="an2-btn ghost" onclick="window.analyticsModule?.deleteManualEntry('${e.id}')" title="Удалить">✕</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>

      </div>
    </div>
  `;
}
