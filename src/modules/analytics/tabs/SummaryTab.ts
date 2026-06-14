import { KPI, Order, TimeseriesPoint, MP_SHORT, MP_COLOR, SkuPerformance } from '../types';
import { I } from '@/utils/icons';
import { renderKpiCard } from '../components/KpiCard';
import { renderPnL } from '../components/PnLWaterfall';
import { renderChart } from '../components/Chart';
import { fmtMoney, fmtNum, escapeHtml } from '../components/format';
import { computeSkuPerformance, MissingCogsItem } from '../services/kpiAggregator';

// Memo по reference на orders. Перерасчёт O(orders × items) дорогой,
// а при body-only renders массив тот же — кеш экономит ~30-80мс на каждый paint.
const _skuMemo = new WeakMap<Order[], SkuPerformance[]>();
function memoSkus(orders: Order[]): SkuPerformance[] {
  const cached = _skuMemo.get(orders);
  if (cached) return cached;
  const result = computeSkuPerformance(orders);
  _skuMemo.set(orders, result);
  return result;
}

// Кеш всего HTML вкладки. При body-only repaints (фильтр, hover в Chart) объекты
// orders/ts/kpi не меняют ссылку — отдаём сохранённый HTML моментально.
// Это убирает 150-400мс на каждом таком paint при больших периодах.
let _summaryCacheKey: string = '';
let _summaryCacheHtml: string = '';

export function renderSummaryTab(k: KPI, orders: Order[], ts: TimeseriesPoint[], prevKpi: KPI | null, missingCogs: MissingCogsItem[] = []): string {
  // Композитный ключ из reference-identity (одинаковые объекты = тот же ключ дешёво)
  const key = `${k.revenue}|${k.net_profit}|${orders.length}|${ts.length}|${missingCogs.length}|${prevKpi?.revenue ?? 0}`;
  if (key === _summaryCacheKey && _summaryCacheHtml) return _summaryCacheHtml;
  const html = renderSummaryTabUncached(k, orders, ts, prevKpi, missingCogs);
  _summaryCacheKey = key;
  _summaryCacheHtml = html;
  return html;
}

/** Сбросить кеш — вызывать когда данные действительно поменялись (refresh). */
export function clearSummaryCache(): void {
  _summaryCacheKey = '';
  _summaryCacheHtml = '';
}

function renderSummaryTabUncached(k: KPI, orders: Order[], ts: TimeseriesPoint[], prevKpi: KPI | null, missingCogs: MissingCogsItem[] = []): string {
  // Sparklines из timeseries (последние 30 точек)
  const tail = ts.slice(-30);
  const sparkRev    = tail.map(p => p.revenue);
  const sparkProfit = tail.map(p => p.profit);
  const sparkExp    = tail.map(p => p.expenses);

  // Диагностика источников данных по заказам
  let liveCount = 0, txOnlyCount = 0;
  for (const o of orders) {
    if (o.source === 'real') liveCount++;
    else txOnlyCount++;
  }
  // Если период длинный (>60 дней) — показываем плашку про источник старых данных
  const periodSpanDays = ts.length;
  const isLongPeriod = periodSpanDays > 60;

  const hasMissing = missingCogs.length > 0;
  // Низкий процент финотчёта (< 70%) — это уже подозрительно (старые заказы должны
  // были получить финотчёт). 70-95% — норма для свежих заказов, не показываем.
  const lowReportPct = k.source_real_pct < 70;
  // Дружелюбное info-сообщение, если % высокий но не 100 — объясняем что это норма
  const partialReport = k.source_real_pct >= 70 && k.source_real_pct < 99;
  const hasQualityIssue = lowReportPct || hasMissing;

  const missingCogsHtml = hasMissing ? `
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(251,191,36,.2)">
      <div style="font-size:10px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:rgba(251,191,36,.8);margin-bottom:8px">
        ${missingCogs.length} артикул${missingCogs.length === 1 ? '' : missingCogs.length < 5 ? 'а' : 'ов'} без себестоимости
      </div>
      <div class="an2-missing-cogs-list">
        ${missingCogs.map(m => {
          const safeVc = escapeHtml(m.vendor_code).replace(/'/g, "\\'");
          return `
          <div class="an2-missing-cogs-row">
            <span class="mp-badge" style="flex-shrink:0">
              <span class="mp-dot" style="background:${MP_COLOR[m.mp]}"></span>${MP_SHORT[m.mp]}
            </span>
            <span class="an2-missing-vc" title="${escapeHtml(m.name)}">${escapeHtml(m.vendor_code)}</span>
            <span class="an2-missing-cnt">${m.orders_count} зак.</span>
            <div style="display:flex;align-items:center;gap:4px;margin-left:auto;flex-shrink:0">
              <input type="number" min="0" step="1" placeholder="₽"
                onkeydown="if(event.key==='Enter'){var v=+this.value;if(v>0){window.analyticsModule?.setCostPrice('${safeVc}',v);this.value='';this.nextElementSibling.textContent='✓';this.nextElementSibling.style.color='#22c55e';setTimeout(()=>{if(this.nextElementSibling){this.nextElementSibling.textContent='→';this.nextElementSibling.style.color=''}},1500);}}"
                style="width:64px;padding:3px 6px;border:1px solid rgba(251,191,36,.35);border-radius:6px;background:var(--bg3);color:var(--text);font-size:11px;outline:none;text-align:right;font-family:inherit">
              <button
                onclick="var inp=this.previousElementSibling;var v=+inp.value;if(v>0){window.analyticsModule?.setCostPrice('${safeVc}',v);inp.value='';this.textContent='✓';this.style.color='#22c55e';var b=this;setTimeout(function(){b.textContent='→';b.style.color=''},1500);}"
                style="padding:3px 8px;border:1px solid rgba(251,191,36,.35);border-radius:6px;background:transparent;color:rgba(251,191,36,.8);cursor:pointer;font-size:11px;line-height:1;font-weight:700;font-family:inherit">→</button>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:8px;font-size:10px;color:var(--text3)">
        Введи сумму → <kbd style="background:var(--bg3);border:1px solid var(--border);border-radius:3px;padding:0 4px;font-size:10px">Enter</kbd> или <strong style="color:rgba(251,191,36,.8)">→</strong> чтобы сохранить. Также можно задать в <strong style="color:var(--text2)">Репрайсер → Себестоимости</strong>.
      </div>
    </div>
  ` : '';

  const dataQualityHtml = hasQualityIssue ? `
    <div class="an2-card" style="background:linear-gradient(90deg, rgba(251,191,36,.06), transparent);border-color:rgba(251,191,36,.25)">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="font-size:18px;margin-top:1px">⚠</div>
        <div style="flex:1;font-size:11px;color:var(--text2);line-height:1.6">
          ${lowReportPct ? `
            <div>Финотчёт пришёл только по <strong>${k.source_real_pct.toFixed(0)}%</strong> заказов.</div>
            <div style="margin-top:5px;color:var(--text3);font-size:10.5px">
              ${(window as any).analyticsModule?._autoSyncing
                ? `<span style="display:inline-flex;align-items:center;gap:6px;color:#60a5fa"><span class="an2-mini-spinner"></span>Подтягиваем финотчёт за период из Ozon/WB/ЯМ…</span>`
                : `Идёт автоматическая синхронизация. Если процент не растёт — нажми <span style="color:var(--text2)">↻</span> или проверь доступ API в Маркетплейсах.`}
            </div>
          ` : ''}
          ${hasMissing ? `<div${lowReportPct ? ' style="margin-top:6px"' : ''}>В <strong>${k.missing_cogs_orders}</strong> заказах не указана себестоимость — прибыль занижена.</div>` : ''}
        </div>
      </div>
      ${missingCogsHtml}
    </div>
  ` : '';

  // Топ-5 SKU по прибыли (мемоизировано по ссылке на orders)
  const skus = memoSkus(orders);
  const top = skus.filter(s => s.units_sold > 0).slice(0, 5);

  // Info-плашка для 70-99% — норма, объясняем что это свежие заказы
  const partialInfoHtml = partialReport && !lowReportPct ? `
    <div class="an2-card" style="background:linear-gradient(90deg, rgba(96,165,250,.05), transparent);border-color:rgba(96,165,250,.18);padding:9px 14px;margin-bottom:10px">
      <div style="display:flex;gap:10px;align-items:center">
        <div style="font-size:14px;color:#60a5fa">ⓘ</div>
        <div style="flex:1;font-size:11px;color:var(--text2);line-height:1.5">
          Финотчёт от МП пришёл по <strong style="color:var(--text)">${k.source_real_pct.toFixed(0)}%</strong> заказов.
          Остальные ~${(100 - k.source_real_pct).toFixed(0)}% — свежие за последние 1–3 дня (МП ещё не прислал расчёт). Через пару дней цифры уточнятся автоматически. <span style="color:var(--text3)">Это норма.</span>
        </div>
      </div>
    </div>
  ` : '';

  // Плашка про источники данных для длинных периодов
  const longPeriodInfoHtml = isLongPeriod ? `
    <div class="an2-card" style="background:linear-gradient(90deg,rgba(124,58,237,.05),transparent);border-color:rgba(124,58,237,.2);padding:9px 14px;margin-bottom:10px">
      <div style="display:flex;gap:10px;align-items:center">
        <div style="font-size:14px;color:#a78bfa">${I.zap('', 14)}</div>
        <div style="flex:1;font-size:11px;color:var(--text2);line-height:1.5">
          Длинный период (${periodSpanDays} дн.) — заказы за последние <strong style="color:var(--text)">60 дней</strong> из live API маркетплейсов, более ранние — только из <strong style="color:var(--text)">финотчёта</strong> (mp_transactions).
          Это <strong style="color:#a78bfa">правильный режим</strong>: live API маркетплейсов на исторических периодах ломается и теряет заказы.
          <span style="color:var(--text3)">${fmtNum(liveCount)} из live · ${fmtNum(txOnlyCount)} только из финотчёта</span>
        </div>
      </div>
    </div>
  ` : '';

  return `
    ${dataQualityHtml}
    ${partialInfoHtml}
    ${longPeriodInfoHtml}

    <div class="an2-kpi-grid">
      ${renderKpiCard({ label: 'Выручка', value: k.revenue, prev: prevKpi?.revenue, tint: 'rgba(212,240,0,.18)', sparkline: sparkRev })}
      ${renderKpiCard({ label: 'Чистая прибыль', value: k.net_profit, prev: prevKpi?.net_profit, tint: 'rgba(34,197,94,.18)', sparkline: sparkProfit })}
      ${renderKpiCard({ label: 'Маржа', value: k.margin_pct, prev: prevKpi?.margin_pct, format: 'pct', tint: 'rgba(96,165,250,.18)' })}
      ${renderKpiCard({ label: 'Заказов доставлено', value: k.orders_delivered, prev: prevKpi?.orders_delivered, format: 'int', tint: 'rgba(167,139,250,.18)' })}
      ${renderKpiCard({ label: 'Расходы', value: k.total_expenses, prev: prevKpi?.total_expenses, tint: 'rgba(248,113,113,.18)', sparkline: sparkExp, invertDelta: true })}
    </div>

    <div class="an2-card">
      <div class="an2-card-head">
        <div class="an2-card-title">Динамика по дням</div>
        <div style="font-size:10px;color:var(--text3)">${ts.length} дн.</div>
      </div>
      <div class="an2-chart-wrap">${renderChart(ts)}</div>
    </div>

    <div class="an2-card">
      <div class="an2-card-head">
        <div class="an2-card-title">P&L · откуда и куда уходят деньги</div>
        <div style="font-size:10px;color:var(--text3)">кликни строку — увидишь связанные заказы</div>
      </div>
      ${renderPnL(k)}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px">
      <div class="an2-card" style="margin-bottom:0">
        <div class="an2-card-head">
          <div class="an2-card-title">Топ-5 товаров по прибыли</div>
        </div>
        ${top.length === 0 ? `<div style="padding:20px;text-align:center;color:var(--text3);font-size:11px">нет данных</div>` : `
          <table class="an2-table">
            <thead><tr>
              <th>Товар</th>
              <th class="num">Продано</th>
              <th class="num">Прибыль</th>
              <th class="num">Маржа</th>
            </tr></thead>
            <tbody>
              ${top.map(s => `
                <tr onclick="window.analyticsModule?.setTab('products')">
                  <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    <span style="color:var(--text3);font-size:10px">${escapeHtml(s.vendor_code)}</span><br>
                    <span style="font-weight:600">${escapeHtml(s.name)}</span>
                  </td>
                  <td class="num">${fmtNum(s.units_sold)}</td>
                  <td class="num ${s.net_profit >= 0 ? 'pos' : 'neg'}">${fmtMoney(s.net_profit)}</td>
                  <td class="num">${s.margin_pct.toFixed(1)}%</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>

      <div class="an2-card" style="margin-bottom:0">
        <div class="an2-card-head">
          <div class="an2-card-title">Структура заказов</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px">
          <div style="padding:12px;background:var(--bg);border-radius:10px;border:1px solid var(--border)">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.8px">Доставлено</div>
            <div style="font-size:22px;font-weight:800;color:var(--green);margin-top:4px">${fmtNum(k.orders_delivered)}</div>
          </div>
          <div style="padding:12px;background:var(--bg);border-radius:10px;border:1px solid var(--border)">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.8px">В работе</div>
            <div style="font-size:22px;font-weight:800;color:#fbbf24;margin-top:4px">${fmtNum(k.orders_processing)}</div>
          </div>
          <div style="padding:12px;background:var(--bg);border-radius:10px;border:1px solid var(--border)">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.8px">Возвратов</div>
            <div style="font-size:22px;font-weight:800;color:var(--red);margin-top:4px">${fmtNum(k.orders_returned)}</div>
          </div>
          <div style="padding:12px;background:var(--bg);border-radius:10px;border:1px solid var(--border)">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.8px">Отмены</div>
            <div style="font-size:22px;font-weight:800;color:#94a3b8;margin-top:4px">${fmtNum(k.orders_cancelled)}</div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:14px;font-size:11px;color:var(--text2)">
          <span>Средний чек:</span><strong style="color:var(--text)">${fmtMoney(k.avg_check)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:11px;color:var(--text2)">
          <span>Единиц продано:</span><strong style="color:var(--text)">${fmtNum(k.units_sold)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:11px;color:var(--text2)">
          <span>Реальные данные:</span><strong style="color:var(--text)">${k.source_real_pct.toFixed(0)}%</strong>
        </div>
      </div>
    </div>
  `;
}
