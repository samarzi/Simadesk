import type { PriceLog, Mp } from '../types';
import { MP_LABEL } from '../types';
import { esc } from '../utils';
import { copyButton } from '@/utils/copyButton';

const I = {
  clipboard: () => `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2"/></svg>`,
  undo: () => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 7"/></svg>`,
};

export function renderLog(log: PriceLog[], reverting: Set<string> = new Set(), revertErrors: Map<string, string> = new Map()): string {
  if (log.length === 0) return `
    <div class="rpr-empty">
      <div class="rpr-empty-icon" style="color:var(--text3)">${I.clipboard()}</div>
      <h3>История пуста</h3>
      <p>Здесь появятся записи когда правила начнут применяться к ценам</p>
    </div>
  `;

  return `
    <div style="overflow:auto;flex:1">
      <table class="rpr-table">
        <thead>
          <tr>
            <th>Товар</th>
            <th>Причина</th>
            <th class="num">Было</th>
            <th class="num">Стало</th>
            <th class="num">Дата</th>
            <th class="num"></th>
          </tr>
        </thead>
        <tbody>
          ${log.map(l => {
            const isReverting = reverting.has(l.id);
            const error = revertErrors.get(l.id);
            const canRevert = !l.isRevert && l.oldPrice != null;
            return `
            <tr>
              <td>
                <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
                  <span class="rpr-mp rpr-mp-${l.marketplace}">${MP_LABEL[l.marketplace as Mp]}</span>
                  <span style="font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${esc(l.productTitle)}</span>${copyButton(l.productTitle, 'Копировать название')}
                </div>
                <div style="display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--text3)">${esc(l.storeName)}${copyButton(l.storeName, 'Копировать название магазина')}</div>
              </td>
              <td style="color:var(--text2);font-size:11.5px">${esc(l.reason)}</td>
              <td class="num" style="color:var(--text2)">${l.oldPrice != null ? l.oldPrice.toLocaleString('ru') + ' ₽' : '—'}</td>
              <td class="num" style="font-weight:700;color:var(--green,#22c55e);font-size:14px">${l.newPrice.toLocaleString('ru')} ₽</td>
              <td class="num" style="font-size:10.5px;color:var(--text3)">
                ${new Date(l.appliedAt).toLocaleDateString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </td>
              <td class="num">
                ${canRevert ? `
                  <button
                    onclick="window.repricerModule.revertLog('${l.id}')"
                    ${isReverting ? 'disabled' : ''}
                    title="${error ? esc(error) : 'Откатить цену на ' + l.oldPrice + ' ₽'}"
                    style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border:1px solid ${error ? 'var(--red,#ef4444)' : 'var(--border)'};background:var(--bg2);color:${error ? 'var(--red,#ef4444)' : 'var(--text2)'};border-radius:6px;cursor:${isReverting ? 'default' : 'pointer'};font-size:10.5px;font-weight:600;opacity:${isReverting ? 0.6 : 1}"
                  >
                    ${I.undo()} ${isReverting ? 'Откат…' : (error ? 'Ошибка' : 'Откатить')}
                  </button>
                ` : ''}
              </td>
            </tr>
          `}).join('')}
        </tbody>
      </table>
    </div>
  `;
}
