import { I } from '@/utils/icons';
import { Order } from '../types';
import { fmtFull } from '../components/format';

const DAYS_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

export type ActivitySubTab = 'heatmap' | 'days' | 'hours' | 'tips';

interface HeatmapCell { revenue: number; count: number }
interface Activity {
  heatmap: HeatmapCell[][];   // [dayOfWeek 0=вс..6=сб][hour 0..23]
  totalRevenue: number;
  totalOrders: number;
  byDay: number[];
  byHour: number[];
}

function computeActivity(orders: Order[]): Activity {
  const heatmap: HeatmapCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ revenue: 0, count: 0 }))
  );
  const byDay:  number[] = new Array(7).fill(0);
  const byHour: number[] = new Array(24).fill(0);
  let totalRevenue = 0, totalOrders = 0;

  for (const o of orders) {
    // Осиротевшие строки расходов и отменённые заказы — не события продажи,
    // в счётчике «Заказов» и в тепловой карте им не место.
    if (o.is_orphan || o.status === 'cancelled') continue;
    const d = new Date(o.date);
    if (isNaN(d.getTime())) continue;
    // Эта вкладка отвечает на вопрос «когда покупают», поэтому база здесь —
    // ЗАКАЗАННОЕ по дате оформления, а не выкупленное. Возврат тоже был спросом,
    // поэтому берём его исходную сумму. Из-за другой базы итог намеренно не
    // совпадает с «Выручкой» в Сводке — метрика подписана как «Заказано».
    const amount = o.revenue + (o.revenue_lost || 0);
    const day  = d.getDay();
    const hour = d.getHours();
    heatmap[day][hour].revenue += amount;
    heatmap[day][hour].count  += 1;
    byDay[day]   += amount;
    byHour[hour] += amount;
    totalRevenue += amount;
    totalOrders  += 1;
  }
  return { heatmap, totalRevenue, totalOrders, byDay, byHour };
}

export function renderActivityTab(orders: Order[], subTab: ActivitySubTab): string {
  const a = computeActivity(orders);
  const noData = a.totalOrders === 0;

  return `
    <div style="padding:14px 20px;background:var(--bg);border-bottom:1px solid var(--border)">
      <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px">Активность продаж по времени</div>
      <div style="font-size:10.5px;color:var(--text3);margin-bottom:12px">
        Считается по <strong style="color:var(--text2)">дате оформления заказа</strong> и по заказанной сумме —
        поэтому итог отличается от «Выручки» в Сводке, где деньги считаются по выкупленным заказам.
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px">
        ${[
          { label: 'Заказов', val: a.totalOrders > 0 ? a.totalOrders.toLocaleString('ru') : '—', color: '#005bff' },
          { label: 'Заказано', val: a.totalRevenue > 0 ? fmtFull(a.totalRevenue) : '—', color: '#059669' },
          { label: 'Лучший день', val: noData ? '—' : DAYS_RU[a.byDay.indexOf(Math.max(...a.byDay))], color: '#7c3aed' },
          { label: 'Пик (час)', val: noData ? '—' : a.byHour.indexOf(Math.max(...a.byHour)) + ':00', color: '#f59e0b' },
        ].map(k => `
          <div style="padding:10px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:10px">
            <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">${k.label}</div>
            <div style="font-size:18px;font-weight:800;color:${k.color}">${k.val}</div>
          </div>`).join('')}
      </div>
    </div>

    ${noData ? renderNoData() : renderSubTabs(subTab, a)}
  `;
}

function renderNoData(): string {
  return `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 40px;gap:12px;color:var(--text2);text-align:center">
      <div style="font-size:36px">${I.inbox()}</div>
      <div style="font-size:15px;font-weight:600;color:var(--text)">Нет заказов за выбранный период</div>
      <div style="font-size:12px;opacity:.7;max-width:340px;line-height:1.6">
        Попробуйте увеличить период или выбрать другой магазин
      </div>
    </div>
  `;
}

function renderSubTabs(subTab: ActivitySubTab, a: Activity): string {
  const labels: Record<ActivitySubTab, string> = {
    heatmap: `${I.flame()} Тепловая карта`,
    days: `${I.calendar()} По дням`,
    hours: `${I.clock()} По часам`,
    tips: `${I.lightbulb()} Советы`,
  };
  return `
    <div style="display:flex;gap:0;padding:0 20px;background:var(--bg2);border-bottom:1px solid var(--border)">
      ${(['heatmap', 'days', 'hours', 'tips'] as const).map(st => {
        const on = subTab === st;
        return `<button onclick="window.analyticsModule?.setActivitySubTab('${st}')"
          style="padding:9px 14px;border:none;cursor:pointer;background:transparent;font-size:12px;
            font-weight:${on ? '700' : '400'};color:${on ? '#7c3aed' : 'var(--text2)'};
            border-bottom:2px solid ${on ? '#7c3aed' : 'transparent'};margin-bottom:-2px;white-space:nowrap">
          ${labels[st]}
        </button>`;
      }).join('')}
    </div>
    <div style="padding:20px;overflow:auto">
      ${subTab === 'heatmap' ? renderHeatmap(a)
        : subTab === 'days' ? renderByDay(a)
        : subTab === 'hours' ? renderByHour(a)
        : renderTips(a)}
    </div>
  `;
}

// ── Тепловая карта ────────────────────────────────────────────────────────────

function renderHeatmap(a: Activity): string {
  let maxRev = 0;
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++)
      if (a.heatmap[d][h].revenue > maxRev) maxRev = a.heatmap[d][h].revenue;

  const cellColor = (rev: number) => {
    if (maxRev === 0 || rev === 0) return 'var(--bg2)';
    const r = rev / maxRev;
    if (r < 0.15) return '#f0fdf4';
    if (r < 0.3)  return '#bbf7d0';
    if (r < 0.5)  return '#4ade80';
    if (r < 0.7)  return '#16a34a';
    if (r < 0.85) return '#15803d';
    return '#14532d';
  };
  const textColor = (rev: number) => {
    if (maxRev === 0 || rev === 0) return 'transparent';
    return rev / maxRev > 0.5 ? '#fff' : '#15803d';
  };

  return `
    <div style="margin-bottom:10px">
      <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px">Тепловая карта продаж</div>
      <div style="font-size:11px;color:var(--text2)">Каждая ячейка — выручка за час в конкретный день недели. Чем темнее — тем больше продаж.</div>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:14px;font-size:10px;color:var(--text2)">
      <span>Мало</span>
      ${['#f0fdf4','#bbf7d0','#4ade80','#16a34a','#15803d','#14532d'].map(c =>
        `<div style="width:20px;height:14px;background:${c};border-radius:3px"></div>`).join('')}
      <span>Много</span>
    </div>
    <div style="overflow-x:auto">
      <table style="border-collapse:separate;border-spacing:3px;font-size:10px">
        <thead>
          <tr>
            <th style="width:32px;text-align:right;padding:0 6px 4px;color:var(--text2);font-weight:600"></th>
            ${Array.from({ length: 24 }, (_, h) =>
              `<th style="width:34px;text-align:center;padding:0 0 4px;color:var(--text2);font-weight:500">${h}</th>`
            ).join('')}
          </tr>
        </thead>
        <tbody>
          ${DAYS_RU.map((day, d) => `
            <tr>
              <td style="text-align:right;padding:0 8px 0 0;color:var(--text2);font-weight:600;white-space:nowrap;font-size:11px">${day}</td>
              ${Array.from({ length: 24 }, (_, h) => {
                const cell = a.heatmap[d][h];
                const bg = cellColor(cell.revenue);
                const tc = textColor(cell.revenue);
                const tip = cell.revenue > 0
                  ? `${cell.revenue.toLocaleString('ru')} ₽, ${cell.count} зак.`
                  : '';
                return `<td title="${tip}"
                  style="width:34px;height:26px;background:${bg};border-radius:4px;text-align:center;
                    vertical-align:middle;cursor:default;font-size:9px;color:${tc}">
                  ${cell.count > 0 ? cell.count : ''}
                </td>`;
              }).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── По дням ───────────────────────────────────────────────────────────────────

function renderByDay(a: Activity): string {
  const maxRev = Math.max(...a.byDay, 1);
  return `
    <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:14px">Выручка по дням недели</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      ${DAYS_RU.map((day, i) => {
        const rev = a.byDay[i];
        const pct = Math.round(rev / maxRev * 100);
        return `
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:28px;font-size:12px;font-weight:600;color:var(--text2)">${day}</div>
            <div style="flex:1;height:28px;background:var(--bg2);border-radius:6px;overflow:hidden;position:relative">
              <div style="position:absolute;inset:0 auto 0 0;width:${pct}%;
                background:linear-gradient(90deg,#7c3aed,#a78bfa);border-radius:6px;transition:width .4s"></div>
              <div style="position:absolute;inset:0;display:flex;align-items:center;padding-left:8px;
                font-size:11px;font-weight:600;color:${pct > 20 ? '#fff' : 'var(--text)'}">
                ${rev > 0 ? rev.toLocaleString('ru') + ' ₽' : '—'}
              </div>
            </div>
            <div style="width:36px;text-align:right;font-size:11px;color:var(--text2)">${pct}%</div>
          </div>`;
      }).join('')}
    </div>
  `;
}

// ── По часам ──────────────────────────────────────────────────────────────────

function renderByHour(a: Activity): string {
  const maxRev = Math.max(...a.byHour, 1);
  return `
    <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:14px">Заказано по часам суток</div>
    <div style="display:flex;gap:2px;align-items:flex-end;height:140px;padding:0 0 24px">
      ${a.byHour.map((rev, h) => {
        const pct = rev / maxRev;
        const height = Math.max(pct * 120, rev > 0 ? 4 : 0);
        return `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;position:relative" title="${h}:00 — ${rev.toLocaleString('ru')} ₽">
            <div style="width:100%;background:${pct > 0.7 ? '#16a34a' : pct > 0.4 ? '#4ade80' : pct > 0.1 ? '#bbf7d0' : 'var(--bg2)'};
              border-radius:3px 3px 0 0;height:${height}px;transition:height .3s;flex-shrink:0;margin-top:auto"></div>
            <div style="position:absolute;bottom:-18px;font-size:9px;color:var(--text3);white-space:nowrap">${h}</div>
          </div>`;
      }).join('')}
    </div>
  `;
}

// ── Советы ────────────────────────────────────────────────────────────────────

function renderTips(a: Activity): string {
  const peakDay = a.byDay.indexOf(Math.max(...a.byDay));
  const positiveDays = a.byDay.filter(v => v > 0);
  const lowDay = positiveDays.length ? a.byDay.indexOf(Math.min(...positiveDays)) : -1;
  const peakHour = a.byHour.indexOf(Math.max(...a.byHour));
  const positiveHours = a.byHour.filter(v => v > 0);
  const lowHour = positiveHours.length ? a.byHour.indexOf(Math.min(...positiveHours)) : -1;

  const tips = [
    {
      title: 'Поднимайте цены в пиковые дни',
      body: `Лучший день продаж — <b>${DAYS_RU[peakDay]}</b>. Создайте правило «По расписанию» с ценой выше в этот день — покупатели готовы платить больше когда активны.`,
      icon: I.chart(),
      color: '#7c3aed',
    },
    {
      title: 'Скидки в медленные дни',
      body: `Самый слабый день — <b>${lowDay >= 0 ? DAYS_RU[lowDay] : '—'}</b>. Небольшое снижение цены в этот день может стимулировать продажи без потери маржи.`,
      icon: I.tag(),
      color: '#059669',
    },
    {
      title: 'Пиковые часы',
      body: `Пик продаж — <b>${peakHour}:00</b>. Убедитесь, что у вас достаточно остатков в это время. Рассмотрите повышение цены в ±2 часа от пика.`,
      icon: I.clock(),
      color: '#f59e0b',
    },
    {
      title: 'Ночные часы',
      body: `Минимум в <b>${lowHour >= 0 ? `${lowHour}:00` : '—'}</b>. Ночью покупатели ищут выгодные предложения — автоматическая скидка поможет выделиться среди конкурентов.`,
      icon: I.moon(),
      color: '#005bff',
    },
  ];

  return `
    <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:14px">Советы по ценообразованию</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">
      ${tips.map(t => `
        <div style="padding:16px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;border-left:4px solid ${t.color}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="color:${t.color}">${t.icon}</span>
            <div style="font-size:13px;font-weight:700;color:var(--text)">${t.title}</div>
          </div>
          <div style="font-size:12px;color:var(--text2);line-height:1.6">${t.body}</div>
        </div>`).join('')}
    </div>
  `;
}
