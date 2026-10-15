/**
 * Проверка данных (выпадающие списки) из Excel.
 *
 * ExcelJS при чтении файла раскладывает правило по отдельным ячейкам: список
 * на колонку A2:A30000 превращается в 30 000 одинаковых записей {"A2": rule,
 * "A3": rule, …}. Документ раздувался до 6 МБ, а редактор для каждой видимой
 * ячейки перебирал все записи и заново разбирал адреса — открытие шаблона
 * остатков занимало 30 секунд.
 *
 *   compactValidations — сводит одинаковые правила в диапазоны (A2:A30000);
 *   ValidationIndex    — разбирает правила один раз и ищет их по строке.
 */

import { parseRangeRef, parseCellRef, colLetter } from './model';

type Rule = Record<string, unknown>;

/** Сжать {адрес: правило}: одинаковые правила — одной записью с диапазонами. */
export function compactValidations(dv: Record<string, Rule>): Record<string, Rule> {
  const entries = Object.entries(dv ?? {});
  if (entries.length < 32) return dv;
  const groups = new Map<string, { rule: Rule; cells: Array<{ r: number; c: number }>; ranges: string[] }>();
  for (const [addr, rule] of entries) {
    const key = JSON.stringify(rule);
    let g = groups.get(key);
    if (!g) { g = { rule, cells: [], ranges: [] }; groups.set(key, g); }
    for (const part of String(addr).split(/\s+/).filter(Boolean)) {
      const clean = part.replace(/\$/g, '');
      const cell = clean.includes(':') ? null : parseCellRef(clean);
      if (cell) g.cells.push(cell); else g.ranges.push(clean);
    }
  }
  const out: Record<string, Rule> = {};
  for (const g of groups.values()) {
    // Ячейки → непрерывные вертикальные отрезки по колонкам
    g.cells.sort((a, b) => a.c - b.c || a.r - b.r);
    const runs: string[] = [];
    let i = 0;
    while (i < g.cells.length) {
      const { c, r } = g.cells[i];
      let end = r;
      while (i + 1 < g.cells.length && g.cells[i + 1].c === c && g.cells[i + 1].r <= end + 1) { i++; end = Math.max(end, g.cells[i].r); }
      runs.push(end === r ? `${colLetter(c)}${r + 1}` : `${colLetter(c)}${r + 1}:${colLetter(c)}${end + 1}`);
      i++;
    }
    const sqref = [...runs, ...g.ranges].join(' ');
    if (sqref) out[sqref] = g.rule;
  }
  return out;
}

interface Compiled { r1: number; c1: number; r2: number; c2: number; rule: Rule }

/** Быстрый поиск правила для ячейки: диапазоны разобраны один раз. */
export class ValidationIndex {
  private byRow = new Map<number, Compiled[]>();
  private tall: Compiled[] = [];

  constructor(dv: Record<string, Rule> | null | undefined) {
    if (!dv || typeof dv !== 'object') return;
    for (const [sqref, rule] of Object.entries(dv)) {
      for (const part of String(sqref).split(/\s+/).filter(Boolean)) {
        const ref = part.includes('!') ? part.slice(part.lastIndexOf('!') + 1) : part;
        const rg = parseRangeRef(ref.replace(/\$/g, ''));
        if (!rg) continue;
        const item = { ...rg, rule };
        // Короткие диапазоны — в корзины строк, высокие (на всю колонку) — общим списком
        if (rg.r2 - rg.r1 < 64) {
          for (let r = rg.r1; r <= rg.r2; r++) {
            let list = this.byRow.get(r);
            if (!list) { list = []; this.byRow.set(r, list); }
            list.push(item);
          }
        } else this.tall.push(item);
      }
    }
  }

  get size(): number { return this.byRow.size + this.tall.length; }

  at(r: number, c: number): Rule | null {
    const row = this.byRow.get(r);
    if (row) for (const v of row) if (c >= v.c1 && c <= v.c2) return v.rule;
    for (const v of this.tall) if (r >= v.r1 && r <= v.r2 && c >= v.c1 && c <= v.c2) return v.rule;
    return null;
  }
}

const cache = new WeakMap<object, ValidationIndex>();

/** Индекс правил листа; пересобирается, только если объект dv заменили. */
export function validationIndexFor(dv: Record<string, Rule> | null | undefined): ValidationIndex | null {
  if (!dv || typeof dv !== 'object') return null;
  let idx = cache.get(dv);
  if (!idx) { idx = new ValidationIndex(dv); cache.set(dv, idx); }
  return idx;
}
