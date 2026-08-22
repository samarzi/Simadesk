import { MP_SHORT, MP_COLOR } from '../../types';
import {
  DetailCtx, detailFrame, deltaOf, card, statGrid, adviceBlock, Advice,
  sparkline, fmtMoney, fmtNum, plural, emptyBlock, escapeHtml,
} from './shared';

const ACCENT = '#fb923c';

export function renderReturnsDetail(c: DetailCtx): string {
  const k = c.kpi;
  const total = k.orders_returned + k.orders_cancelled;
  const closed = k.orders_delivered + k.orders_returned + k.orders_cancelled;
  const returnPct = closed > 0 ? (k.orders_returned  / closed) * 100 : 0;
  const cancelPct = closed > 0 ? (k.orders_cancelled / closed) * 100 : 0;

  // ── Динамика по дням ──
  const retByDay = new Map<string, number>();
  const canByDay = new Map<string, number>();
  for (const o of c.orders) {
    if (!o.date) continue;
    const d = o.date.slice(0, 10);
    if (o.status === 'returned')  retByDay.set(d, (retByDay.get(d) ?? 0) + 1);
    if (o.status === 'cancelled') canByDay.set(d, (canByDay.get(d) ?? 0) + 1);
  }
  const retSeries = c.ts.map(p => retByDay.get(p.date) ?? 0);
  const canSeries = c.ts.map(p => canByDay.get(p.date) ?? 0);

  // ── Разбивка по МП ──
  type MpRow = { mp: string; ret: number; can: number };
  const byMp = new Map<string, MpRow>();
  for (const o of c.orders) {
    if (o.status !== 'returned' && o.status !== 'cancelled') continue;
    const mp = o.mp ?? 'ozon';
    if (!byMp.has(mp)) byMp.set(mp, { mp, ret: 0, can: 0 });
    const r = byMp.get(mp)!;
    if (o.status === 'returned')  r.ret++;
    if (o.status === 'cancelled') r.can++;
  }
  const mpRows = [...byMp.values()].sort((a, b) => (b.ret + b.can) - (a.ret + a.can));

  // ── Топ товаров по возвратам + отменам ──
  type SkuRow = { name: string; vendorCode: string; returns: number; cancels: number };
  const bySku = new Map<string, SkuRow>();
  for (const o of c.orders) {
    if (o.status !== 'returned' && o.status !== 'cancelled') continue;
    for (const it of o.items) {
      const key = it.vendor_code || it.name;
      if (!bySku.has(key)) bySku.set(key, { name: it.name, vendorCode: it.vendor_code, returns: 0, cancels: 0 });
      const r = bySku.get(key)!;
      if (o.status === 'returned')  r.returns++;
      if (o.status === 'cancelled') r.cancels++;
    }
  }
  const topSku = [...bySku.values()]
    .sort((a, b) => (b.returns + b.cancels) - (a.returns + a.cancels))
    .slice(0, 10);

  // ── Упущенная выручка ──
  const lostRevenue = c.orders
    .filter(o => o.status === 'returned' || o.status === 'cancelled')
    .reduce((s, o) => s + (o.revenue_lost ?? 0) + (o.revenue ?? 0), 0);

  // ── Советы ──
  const advice: Advice[] = [];
  if (returnPct >= 15) {
    advice.push({
      level: 'bad',
      title: `Высокий процент возвратов — ${returnPct.toFixed(0)}%`,
      text: `${fmtNum(k.orders_returned)} ${plural(k.orders_returned, 'заказ возвращён', 'заказа возвращено', 'заказов возвращено')}. Каждый возврат — двойные расходы на логистику и упущенная продажа. Проверь топовые артикулы: несоответствие фото, размерная сетка, качество описания.`,
    });
  } else if (returnPct >= 8) {
    advice.push({
      level: 'warn',
      title: `Возвраты — ${returnPct.toFixed(1)}%`,
      text: 'Пока в норме, но каждый процент бьёт по марже через обратную логистику. Стоит найти проблемные артикулы.',
    });
  } else if (closed >= 10) {
    advice.push({
      level: 'good',
      title: `Возвраты в норме — ${returnPct.toFixed(1)}%`,
      text: 'Покупатели редко возвращают товары. Поддерживай качество описаний и фото, чтобы сохранить этот уровень.',
    });
  }
  if (cancelPct >= 10) {
    advice.push({
      level: 'warn',
      title: `Отмены до доставки — ${cancelPct.toFixed(0)}%`,
      text: `${fmtNum(k.orders_cancelled)} ${plural(k.orders_cancelled, 'заказ отменён', 'заказа отменено', 'заказов отменено')}. Частые причины: нет остатков, долгая сборка, срыв срока отгрузки. Отмены по вине продавца площадка учитывает в рейтинге.`,
    });
  }

  // ── HTML ──
  const legendHtml = `
    <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:11px;color:var(--text2);margin-bottom:8px">
      <span><span style="color:#f87171;font-weight:700">■</span> Возврат — покупатель получил товар и вернул</span>
      <span><span style="color:#94a3b8;font-weight:700">■</span> Отмена — заказ отменён до доставки</span>
    </div>`;

  const statsHtml = statGrid([
    { label: 'Возвращено', value: fmtNum(k.orders_returned), hint: `${returnPct.toFixed(1)}% от закрытых` },
    { label: 'Отменено',   value: fmtNum(k.orders_cancelled), hint: `${cancelPct.toFixed(1)}% от закрытых` },
    { label: 'Итого',      value: fmtNum(total) },
    { label: 'Упущено выручки', value: fmtMoney(lostRevenue) },
  ]);

  const retSparkHtml = retSeries.some(v => v > 0)
    ? card('Динамика возвратов по дням', sparkline(retSeries, ACCENT))
    : '';
  const canSparkHtml = canSeries.some(v => v > 0)
    ? card('Динамика отмен по дням', sparkline(canSeries, '#94a3b8'))
    : '';

  const mpTableHtml = mpRows.length > 0 ? card('По маркетплейсу', `
    <table class="an2-table">
      <thead><tr><th>МП</th><th class="num">Возвраты</th><th class="num">Отмены</th><th class="num">Итого</th></tr></thead>
      <tbody>
        ${mpRows.map(r => {
          const color = MP_COLOR[r.mp as keyof typeof MP_COLOR] ?? '#888';
          const label = MP_SHORT[r.mp as keyof typeof MP_SHORT] ?? r.mp;
          return `<tr>
            <td><span style="color:${color};font-weight:700">${label}</span></td>
            <td class="num">${fmtNum(r.ret)}</td>
            <td class="num">${fmtNum(r.can)}</td>
            <td class="num" style="font-weight:700">${fmtNum(r.ret + r.can)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `) : '';

  const skuTableHtml = topSku.length > 0 ? card('Топ товаров по возвратам и отменам', `
    <table class="an2-table">
      <thead><tr>
        <th>Товар</th>
        <th class="num">Возвраты</th>
        <th class="num">Отмены</th>
      </tr></thead>
      <tbody>
        ${topSku.map(r => `
          <tr>
            <td>
              <div style="font-size:10px;color:var(--text3)">${escapeHtml(r.vendorCode)}</div>
              <div style="font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.name)}</div>
            </td>
            <td class="num">${r.returns > 0 ? `<span style="color:#f87171;font-weight:700">${fmtNum(r.returns)}</span>` : '—'}</td>
            <td class="num">${r.cancels > 0 ? `<span style="color:#94a3b8;font-weight:700">${fmtNum(r.cancels)}</span>` : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div style="font-size:10px;color:var(--text3);margin-top:10px">Топ-10 по общему количеству</div>
  `) : emptyBlock('Нет данных по товарам');

  const body = `
    ${legendHtml}
    ${statsHtml}
    ${adviceBlock(advice)}
    ${retSparkHtml}
    ${canSparkHtml}
    ${mpTableHtml}
    ${skuTableHtml}
  `;

  return detailFrame({
    title: 'Возвраты и отмены',
    value: fmtNum(total),
    subtitle: `${c.periodLabel} · ${c.storeName}`,
    accent: ACCENT,
    delta: deltaOf(total, c.prevKpi ? c.prevKpi.orders_returned + c.prevKpi.orders_cancelled : null, true),
    body,
  });
}
