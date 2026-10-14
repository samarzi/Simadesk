/**
 * Юнит-экономика: текстовый отчёт (для мессенджера) и листы Excel.
 * Без зависимостей от интерфейса — используется вкладкой и тестами.
 */

import { MP_SHORT } from '../types';
import { UnitEconResult } from './unitEconomics';
import { Sheet } from './exporter';
import { rub as fmtFull, rub2 as fmtRub2, num as fmtNum, qty as fmtQty, pct as fmtPct } from '../ui/format';

const BASIS_HINT: Record<string, string> = {
  sku: 'по истории этого товара',
  store: 'среднее по магазину — у товара мало истории',
  none: 'нет истории — из настроек',
  manual: 'задан вручную',
};

function pctPair(a: number, b: number): string {
  return `${fmtPct(a, 2)} / ${fmtPct(b, 2)}`;
}

// ── Текстовый отчёт и выгрузка ──────────────────────────────────────────

const rub = (v: number) => fmtRub2(v);
const nf = (v: number) => v == null ? 'не получены' : rub(v);

/** Отчёт в виде текста — для мессенджера. */
export function unitReportText(r: UnitEconResult, title: string): string {
  const L: string[] = [];
  L.push(`Юнит-экономика · ${title}`);
  L.push(`Итого: ${fmtNum(r.orderedUnits)} шт., ${fmtNum(r.orders)} заказов`);
  L.push(`Выручка заказанная: ${fmtFull(r.orderedRevenue)}`);
  L.push(`Ожидаемый выкуп ${fmtPct(r.buyoutPct, 0)}: ${fmtQty(r.boughtUnits)} шт.; выкупленная выручка ${fmtFull(r.boughtRevenue)}`);
  L.push('');
  L.push(`Реклама всего: ${rub(r.ads.total)}`);
  L.push(`• на заказанную шт: ${rub(r.ads.perOrderedUnit)}`);
  L.push(`• на выкуп. шт: ${rub(r.ads.perBoughtUnit)}`);
  L.push(`ДРР общий: ${pctPair(r.ads.drrOrdered, r.ads.drrBought)}`);
  for (const g of r.ads.groups) L.push(`• ${g.label}: ${rub(g.money)}; ДРР ${pctPair(g.drrOrdered, g.drrBought)}`);
  if (r.ads.strategies.length) {
    L.push('По стратегиям:');
    for (const g of r.ads.strategies) L.push(`• ${g.label}: ${rub(g.money)}; ДРР ${pctPair(g.drrOrdered, g.drrBought)}`);
  }
  if (r.ads.bonus > 0) {
    L.push('Справочно, без влияния на юнитку (бонусы):');
    for (const b of r.ads.bonusGroups) L.push(`• ${b.label}: ${rub(b.amount)}`);
  }
  L.push('');
  L.push('Расходы на выкуп. шт:');
  for (const c of r.costs) if (c.key !== 'ads') L.push(`• ${c.label.toLowerCase()}: ${c.total ? rub(c.perUnit) : 'нет данных'}`);
  L.push(`• штрафы: ${nf(r.facts.penalties as number)}`);
  L.push(`• прочие удержания: ${nf(r.facts.other as number)}`);
  L.push('');
  L.push(`Итоговая прибыль: ${rub(r.profit)}`);
  L.push(`Прибыль/выкуп. шт: ${rub(r.profitPerUnit)}`);
  L.push(`ROI: ${r.roi == null ? '—' : fmtPct(r.roi, 2)}`);
  if (r.scenario) {
    L.push('');
    L.push(`Сценарий себестоимость ${rub(r.scenario.cost)}:`);
    L.push(`• итоговая прибыль: ${rub(r.scenario.profit)}`);
    L.push(`• прибыль/выкуп. шт: ${rub(r.scenario.profitPerUnit)}`);
    L.push(`• ROI: ${r.scenario.roi == null ? '—' : fmtPct(r.scenario.roi, 2)}`);
  }
  if (r.fbs) {
    L.push('');
    L.push(`FBS передано за период: ${fmtNum(r.fbs.units)} шт., ${fmtNum(r.fbs.postings)} отправлений`);
    L.push(`Выручка этих FBS: ${fmtFull(r.fbs.revenue)}`);
  }
  if (r.nuances.length) {
    L.push('');
    L.push(`Нюансы: ${r.nuances.length}`);
    for (const n of r.nuances) L.push(`• ${n.text}`);
  }
  return L.join('\n');
}

export function unitSheets(r: UnitEconResult, title: string): Sheet[] {
  return [
    {
      name: 'Итоги',
      rows: [
        ['Показатель', 'Значение'],
        ['Период', title],
        ['Заказов', r.orders],
        ['Заказано, шт', r.orderedUnits],
        ['Выручка заказанная, ₽', r.orderedRevenue],
        ['Ожидаемый выкуп, %', r.buyoutPct],
        ['Выкуплено, шт', r.boughtUnits],
        ['Выручка выкупленная, ₽', r.boughtRevenue],
        ['Реклама, ₽', r.ads.total],
        ['ДРР от заказанной, %', r.ads.drrOrdered],
        ['ДРР от выкупленной, %', r.ads.drrBought],
        ['Итоговая прибыль, ₽', r.profit],
        ['Прибыль на выкуп. шт, ₽', r.profitPerUnit],
        ['ROI, %', r.roi],
        ['Штрафы фактом, ₽', r.facts.penalties],
        ['Хранение фактом, ₽', r.facts.storage],
        ['Прочие удержания фактом, ₽', r.facts.other],
        ...(r.scenario ? [
          ['Сценарий: себестоимость, ₽', r.scenario.cost],
          ['Сценарий: прибыль, ₽', r.scenario.profit],
          ['Сценарий: ROI, %', r.scenario.roi],
        ] as Array<[string, number | null]> : []),
      ],
    },
    {
      name: 'Расходы на шт',
      rows: [['Статья', '₽ на выкуп. шт', '% цены', 'За период, ₽', 'Источник'],
        ...r.costs.map(c => [c.label, c.perUnit, c.pctOfPrice, c.total, c.source])],
      formats: { 1: 'money2', 2: 'pct', 3: 'money2' },
    },
    {
      name: 'Реклама',
      rows: [['Группа', 'Расход, ₽', 'ДРР заказ, %', 'ДРР выкуп, %'],
        ...r.ads.groups.map(g => [g.label, g.money, g.drrOrdered, g.drrBought]),
        ...r.ads.strategies.map(g => [`Стратегия: ${g.label}`, g.money, g.drrOrdered, g.drrBought]),
        ...r.ads.bonusGroups.map(b => [`Бонусы (справочно): ${b.label}`, b.amount, null, null])],
      formats: { 1: 'money2', 2: 'pct', 3: 'pct' },
    },
    {
      name: 'Товары',
      rows: [['МП', 'Артикул', 'SKU', 'Название', 'Заказов', 'Заказано, шт', 'Цена, ₽', 'Выручка заказ., ₽', 'Выкуп, %', 'Выкуп по',
        'Выкуплено, шт', 'Себест./шт', 'Комиссия/шт', 'Налог/шт', 'Эквайринг/шт', 'Логистика/шт', 'Посл. миля/шт',
        'Обр. логистика/шт', 'Прочее/шт', 'Ставки по', 'Реклама, ₽', 'ДРР заказ, %', 'ДРР выкуп, %', 'Прибыль/шт', 'Прибыль, ₽', 'ROI, %', 'Маржа, %'],
        ...r.skus.map(x => [MP_SHORT[x.mp], x.vendor_code, x.mp_sku, x.name, x.orders, x.orderedUnits, x.price, x.orderedRevenue,
          x.buyoutPct, BASIS_HINT[x.buyoutBasis], x.boughtUnits, x.cogsPerUnit, x.commissionPerUnit, x.taxPerUnit, x.acquiringPerUnit,
          x.logisticsPerUnit, x.lastMilePerUnit, x.returnLogisticsPerUnit, x.otherPerUnit, BASIS_HINT[x.feesBasis], x.ads,
          x.drrOrdered, x.drrBought, x.profitPerUnit, x.profit, x.roi, x.margin])],
      formats: { 6: 'money2', 7: 'money', 8: 'pct', 10: 'qty', 11: 'money2', 12: 'money2', 13: 'money2', 14: 'money2', 15: 'money2',
        16: 'money2', 17: 'money2', 18: 'money2', 20: 'money2', 21: 'pct', 22: 'pct', 23: 'money2', 24: 'money2', 25: 'pct', 26: 'pct' },
    },
    { name: 'Нюансы', rows: [['Уровень', 'Текст'], ...r.nuances.map(n => [n.level === 'warn' ? 'важно' : 'инфо', n.text])] },
  ];
}
