import { KPI } from '../types';
import { fmtMoney } from './format';
import { I } from '@/utils/icons';

interface Row {
  icon: string;
  label: string;
  value: number;
  tint: string;
  /** Тип строки: income/expense/total — для цвета и логики долей. */
  kind: 'income' | 'expense' | 'total';
  /** Имя фильтра при клике (передаётся в openOrdersFiltered). */
  filter?: string;
}

export function renderPnL(k: KPI, onFilterClick = 'window.analyticsModule?.openOrdersFiltered'): string {
  const baseRev = Math.max(1, k.revenue);
  const rows: Row[] = [
    { icon: 'checkCircle', label: 'Выручка (нетто)',  value: k.revenue,        tint: 'var(--green)',    kind: 'income',  filter: 'delivered' },
    { icon: '↩',  label: 'Возвраты',          value: -k.returns_revenue, tint: 'var(--red)',    kind: 'expense', filter: 'returned' },
    { icon: 'wallet', label: 'Комиссия МП',       value: -k.commission,    tint: '#fb923c',         kind: 'expense', filter: 'commission' },
    { icon: 'truck', label: 'Логистика',         value: -k.logistics,     tint: '#60a5fa',         kind: 'expense', filter: 'logistics' },
    { icon: 'receipt', label: 'Услуги/штрафы/реклама', value: -k.services,  tint: '#a78bfa',         kind: 'expense' },
    { icon: 'package', label: 'Себестоимость',     value: -k.cogs,          tint: '#22d3ee',         kind: 'expense' },
    { icon: 'percent',   label: 'Налог',             value: -k.tax,           tint: '#f472b6',         kind: 'expense' },
    { icon: 'dollarSign', label: 'Чистая прибыль',    value: k.net_profit,     tint: k.net_profit >= 0 ? 'var(--green)' : 'var(--red)', kind: 'total' },
  ];

  const maxAbs = Math.max(...rows.map(r => Math.abs(r.value)), 1);

  return `
    <div class="an2-pnl">
      ${rows.map(r => {
        if (r.value === 0 && r.kind === 'expense') return '';
        const sharePct = baseRev > 0 ? Math.abs(r.value) / baseRev * 100 : 0;
        const barPct = Math.min(100, Math.abs(r.value) / maxAbs * 100);
        const cls = r.kind === 'total'
          ? 'an2-pnl-row total'
          : `an2-pnl-row ${r.value < 0 ? 'negative' : 'positive'}`;
        const onclick = r.filter ? `onclick="${onFilterClick}('${r.filter}')"` : '';
        return `
          <div class="${cls}" style="--an-tint: ${r.tint}" ${onclick}>
            <div class="an2-pnl-icon">${(I as any)[r.icon]?.('', 16) ?? r.icon}</div>
            <div>
              <div class="an2-pnl-label">${r.label}</div>
              <div class="an2-pnl-bar" style="width: ${barPct}%"></div>
            </div>
            <div class="an2-pnl-amount">${fmtMoney(r.value)}</div>
            <div class="an2-pnl-share">${r.kind === 'total' ? `маржа ${k.margin_pct.toFixed(1)}%` : `${sharePct.toFixed(1)}%`}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}
