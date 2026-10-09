/**
 * formula — вычислитель формул электронной таблицы.
 *
 * Заменяет прежний разбор регулярками, который не умел вложенные вызовы:
 * `=SUM(ABS(A1),B1)` и `=IF(A1>0,SUM(B1:B5),0)` там просто ломались, потому
 * что маска `[^()]+` обрывалась на первой внутренней скобке.
 *
 * Здесь честная цепочка: токенизатор → рекурсивный спуск по приоритетам →
 * вычисление AST. Ссылки на ячейки резолвятся лениво, с мемоизацией и
 * обнаружением циклов, поэтому пересчёт листа линеен, а не экспоненциален.
 */

import { dateToSerial, serialToDate } from './numFormat';

// ─────────────────────────── Значения ────────────────────────────────────

export interface FErr { err: string }
export type Scalar = number | string | boolean | FErr;
/** Диапазон разворачивается в плоский список значений. */
export type FValue = Scalar | Scalar[];

export const isErr = (v: unknown): v is FErr =>
  typeof v === 'object' && v !== null && 'err' in (v as any);

const ERR = {
  div0:  { err: '#DIV/0!' } as FErr,
  value: { err: '#VALUE!' } as FErr,
  ref:   { err: '#REF!' } as FErr,
  name:  { err: '#NAME?' } as FErr,
  na:    { err: '#N/A' } as FErr,
  num:   { err: '#NUM!' } as FErr,
  circ:  { err: '#ЦИКЛ!' } as FErr,
};

// ─────────────────────────── Токенизатор ─────────────────────────────────

type TokKind = 'num' | 'str' | 'ref' | 'range' | 'name' | 'op' | 'lparen' | 'rparen' | 'sep';
/** sheet — имя листа у ссылок вида «'Лист 1'!A1» и «Итоги!B2:B9». */
interface Tok { kind: TokKind; text: string; sheet?: string }

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;
const COL_RE = /^\$?([A-Za-z]{1,3})$/;

/**
 * Прочитать адресную часть после «Лист!»: A1, A1:B5 или A:C.
 * Возвращает токен и позицию после него, либо null.
 */
function readAddress(src: string, i: number): { tok: Tok; end: number } | null {
  let j = i, a = '';
  while (j < src.length && /[A-Za-z0-9$]/.test(src[j])) a += src[j++];
  if (!a) return null;
  if (src[j] === ':') {
    let k = j + 1, b = '';
    while (k < src.length && /[A-Za-z0-9$]/.test(src[k])) b += src[k++];
    if ((CELL_RE.test(a) && CELL_RE.test(b)) || (COL_RE.test(a) && COL_RE.test(b)))
      return { tok: { kind: 'range', text: a + ':' + b }, end: k };
  }
  if (CELL_RE.test(a)) return { tok: { kind: 'ref', text: a }, end: j };
  return null;
}

const OPS2 = ['<=', '>=', '<>'];
// ':' нужен отдельным оператором для диапазонов, записанных с пробелами
// («B2 : B4»): быстрый путь в токенизаторе ловит только слитную запись.
const OPS1 = ['+', '-', '*', '/', '^', '&', '=', '<', '>', '%', ':'];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

    // Строка в двойных кавычках; "" внутри — экранированная кавычка
    if (ch === '"') {
      let s = ''; i++;
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { s += '"'; i += 2; continue; }
          i++; break;
        }
        s += src[i++];
      }
      out.push({ kind: 'str', text: s });
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      let s = '';
      while (i < src.length && /[0-9]/.test(src[i])) s += src[i++];
      if (src[i] === '.' || src[i] === ',') {
        // Запятая как десятичный разделитель — только если дальше цифра
        // и мы не внутри списка аргументов (там запятая разделяет).
        if (src[i] === '.' || /[0-9]/.test(src[i + 1] ?? '')) {
          if (src[i] === '.') { s += '.'; i++; while (i < src.length && /[0-9]/.test(src[i])) s += src[i++]; }
        }
      }
      if (/[eE]/.test(src[i] ?? '') && /[0-9+-]/.test(src[i + 1] ?? '')) {
        s += src[i++];
        if (/[+-]/.test(src[i])) s += src[i++];
        while (i < src.length && /[0-9]/.test(src[i])) s += src[i++];
      }
      out.push({ kind: 'num', text: s });
      continue;
    }

    if (ch === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
      let s = '.'; i++;
      while (i < src.length && /[0-9]/.test(src[i])) s += src[i++];
      out.push({ kind: 'num', text: s });
      continue;
    }

    // Литерал ошибки (#REF! и т.п.) — появляется после удаления строк
    if (ch === '#') {
      const m = src.slice(i).match(/^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|ЦИКЛ!)/i);
      if (m) { out.push({ kind: 'name', text: m[0].toUpperCase() }); i += m[0].length; continue; }
    }

    // Ссылка на другой лист с именем в кавычках: 'Лист 1'!A1:B5
    if (ch === "'") {
      let name = '', j = i + 1;
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") { name += "'"; j += 2; continue; }
          j++; break;
        }
        name += src[j++];
      }
      if (src[j] === '!') {
        const addr = readAddress(src, j + 1);
        if (addr) { out.push({ ...addr.tok, sheet: name }); i = addr.end; continue; }
      }
      i = j;
      continue;
    }

    // Ссылка, диапазон или имя функции. $ в адресах допускается и игнорируется.
    if (/[A-Za-zА-Яа-яЁё_$]/.test(ch)) {
      let s = '';
      while (i < src.length && /[A-Za-zА-Яа-яЁё0-9_.$]/.test(src[i])) s += src[i++];

      // Лист без кавычек: Итоги!B2
      if (src[i] === '!') {
        const addr = readAddress(src, i + 1);
        if (addr) { out.push({ ...addr.tok, sheet: s }); i = addr.end; continue; }
      }

      // Колонки целиком: A:A, B:D
      if (COL_RE.test(s) && src[i] === ':') {
        let j = i + 1, t = '';
        while (j < src.length && /[A-Za-z$]/.test(src[j])) t += src[j++];
        if (COL_RE.test(t) && !/[0-9]/.test(src[j] ?? '')) {
          out.push({ kind: 'range', text: s + ':' + t }); i = j; continue;
        }
      }

      const refRe = CELL_RE;
      if (refRe.test(s)) {
        // Диапазон A1:B10 — двоеточие сразу за адресом
        if (src[i] === ':') {
          let j = i + 1, t = '';
          while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) t += src[j++];
          if (refRe.test(t)) { out.push({ kind: 'range', text: s + ':' + t }); i = j; continue; }
        }
        out.push({ kind: 'ref', text: s });
        continue;
      }
      out.push({ kind: 'name', text: s.toUpperCase() });
      continue;
    }

    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { out.push({ kind: 'op', text: two }); i += 2; continue; }
    if (OPS1.includes(ch))  { out.push({ kind: 'op', text: ch }); i++; continue; }
    if (ch === '(') { out.push({ kind: 'lparen', text: ch }); i++; continue; }
    if (ch === ')') { out.push({ kind: 'rparen', text: ch }); i++; continue; }
    if (ch === ',' || ch === ';') { out.push({ kind: 'sep', text: ch }); i++; continue; }

    // Неизвестный символ — пропускаем, чтобы не ронять весь лист
    i++;
  }
  return out;
}

// ─────────────────────────── AST и парсер ────────────────────────────────

/**
 * sh — лист, на который указывает ссылка (нет — текущий).
 * У диапазона колонок целиком (A:C) r2 = OPEN_END: конец берётся по
 * фактическому размеру листа в момент вычисления.
 */
type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ref'; r: number; c: number; sh?: string }
  | { k: 'range'; r1: number; c1: number; r2: number; c2: number; sh?: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'un'; op: string; v: Node }
  | { k: 'pct'; v: Node }
  | { k: 'err'; v: FErr };

export function letterToCol(l: string): number {
  let n = 0;
  for (const ch of l.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colToLetter(n: number): string {
  let s = ''; n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function parseRef(text: string): { r: number; c: number } | null {
  const m = text.match(/^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/);
  if (!m) return null;
  return { r: +m[2] - 1, c: letterToCol(m[1]) };
}

const OPEN_END = Number.MAX_SAFE_INTEGER;

/** «A1:B5» или «A:C» → границы диапазона (r2 = OPEN_END для колонок целиком). */
function parseRangeText(text: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const [a, b] = text.split(':');
  const ra = parseRef(a), rb = parseRef(b);
  if (ra && rb) {
    return { r1: Math.min(ra.r, rb.r), c1: Math.min(ra.c, rb.c), r2: Math.max(ra.r, rb.r), c2: Math.max(ra.c, rb.c) };
  }
  const ca = a?.match(COL_RE), cb = b?.match(COL_RE);
  if (ca && cb) {
    const x = letterToCol(ca[1]), y = letterToCol(cb[1]);
    return { r1: 0, c1: Math.min(x, y), r2: OPEN_END, c2: Math.max(x, y) };
  }
  return null;
}

/**
 * Русские имена функций → английские. Пользователи и ассистент пишут
 * «=СУММ(A1:A5)» — раньше такая формула давала #NAME?, а в выгрузку .xlsx
 * уходила в виде, который Excel не открывает.
 */
export const RU_FUNCTIONS: Record<string, string> = {
  'СУММ': 'SUM', 'СРЗНАЧ': 'AVERAGE', 'МИН': 'MIN', 'МАКС': 'MAX', 'СЧЁТ': 'COUNT', 'СЧЕТ': 'COUNT',
  'СЧЁТЗ': 'COUNTA', 'СЧЕТЗ': 'COUNTA', 'СЧИТАТЬПУСТОТЫ': 'COUNTBLANK', 'ПРОИЗВЕД': 'PRODUCT',
  'МЕДИАНА': 'MEDIAN', 'СТАНДОТКЛОН': 'STDEV', 'СТАНДОТКЛОН.В': 'STDEV.S', 'СТАНДОТКЛОН.Г': 'STDEV.P',
  'СУММПРОИЗВ': 'SUMPRODUCT', 'СЧЁТЕСЛИ': 'COUNTIF', 'СЧЕТЕСЛИ': 'COUNTIF', 'СЧЁТЕСЛИМН': 'COUNTIFS',
  'СЧЕТЕСЛИМН': 'COUNTIFS', 'СУММЕСЛИ': 'SUMIF', 'СУММЕСЛИМН': 'SUMIFS', 'СРЗНАЧЕСЛИ': 'AVERAGEIF',
  'СРЗНАЧЕСЛИМН': 'AVERAGEIFS', 'МАКСЕСЛИ': 'MAXIFS', 'МИНЕСЛИ': 'MINIFS',
  'ЕСЛИ': 'IF', 'ЕСЛИМН': 'IFS', 'ЕСЛИОШИБКА': 'IFERROR', 'ЕСНД': 'IFNA', 'И': 'AND', 'ИЛИ': 'OR',
  'НЕ': 'NOT', 'ИСКЛИЛИ': 'XOR', 'ВПР': 'VLOOKUP', 'ГПР': 'HLOOKUP', 'ПРОСМОТРX': 'XLOOKUP',
  'ИНДЕКС': 'INDEX', 'ПОИСКПОЗ': 'MATCH', 'ВЫБОР': 'CHOOSE', 'ABS': 'ABS', 'ОКРУГЛ': 'ROUND',
  'ОКРУГЛВВЕРХ': 'ROUNDUP', 'ОКРУГЛВНИЗ': 'ROUNDDOWN', 'ОКРВВЕРХ': 'CEILING', 'ОКРВНИЗ': 'FLOOR',
  'ЦЕЛОЕ': 'INT', 'ОТБР': 'TRUNC', 'КОРЕНЬ': 'SQRT', 'СТЕПЕНЬ': 'POWER', 'ОСТАТ': 'MOD', 'ЗНАК': 'SIGN',
  'EXP': 'EXP', 'LN': 'LN', 'LOG': 'LOG', 'LOG10': 'LOG10', 'ПИ': 'PI', 'СЛЧИС': 'RAND',
  'СЛУЧМЕЖДУ': 'RANDBETWEEN', 'СЦЕПИТЬ': 'CONCATENATE', 'СЦЕП': 'CONCAT', 'ОБЪЕДИНИТЬ': 'TEXTJOIN',
  'ДЛСТР': 'LEN', 'ЛЕВСИМВ': 'LEFT', 'ПРАВСИМВ': 'RIGHT', 'ПСТР': 'MID', 'СЖПРОБЕЛЫ': 'TRIM',
  'ПРОПИСН': 'UPPER', 'СТРОЧН': 'LOWER', 'ПРОПНАЧ': 'PROPER', 'ПОДСТАВИТЬ': 'SUBSTITUTE',
  'ЗАМЕНИТЬ': 'REPLACE', 'НАЙТИ': 'FIND', 'ПОИСК': 'SEARCH', 'СОВПАД': 'EXACT', 'ПОВТОР': 'REPT',
  'ТЕКСТ': 'TEXT', 'ЗНАЧЕН': 'VALUE', 'СЕГОДНЯ': 'TODAY', 'ТДАТА': 'NOW', 'ДАТА': 'DATE', 'ГОД': 'YEAR',
  'МЕСЯЦ': 'MONTH', 'ДЕНЬ': 'DAY', 'ЧАС': 'HOUR', 'МИНУТЫ': 'MINUTE', 'СЕКУНДЫ': 'SECOND',
  'ДЕНЬНЕД': 'WEEKDAY', 'ДНИ': 'DAYS', 'ДАТАМЕС': 'EDATE', 'КОНМЕСЯЦА': 'EOMONTH', 'РАЗНДАТ': 'DATEDIF',
  'ЕПУСТО': 'ISBLANK', 'ЕЧИСЛО': 'ISNUMBER', 'ЕТЕКСТ': 'ISTEXT', 'ЕОШИБКА': 'ISERROR', 'ЕНД': 'ISNA',
  'НД': 'NA', 'Ч': 'N', 'Т': 'T', 'ПРОМЕЖУТОЧНЫЕ.ИТОГИ': 'SUBTOTAL', 'НАИБОЛЬШИЙ': 'LARGE',
  'НАИМЕНЬШИЙ': 'SMALL', 'РАНГ': 'RANK', 'РАНГ.РВ': 'RANK.EQ', 'ЕЧЁТН': 'ISEVEN', 'ЕНЕЧЁТ': 'ISODD',
  'ЧАСТНОЕ': 'QUOTIENT', 'НОМНЕДЕЛИ': 'WEEKNUM', 'ЧИСТРАБДНИ': 'NETWORKDAYS', 'СИМВОЛ': 'CHAR',
  'КОДСИМВ': 'CODE', 'ПЕЧСИМВ': 'CLEAN', 'СТРОКА': 'ROW', 'СТОЛБЕЦ': 'COLUMN', 'ЧСТРОК': 'ROWS',
  'ЧИСЛСТОЛБ': 'COLUMNS', 'ДИСП': 'VAR', 'ДИСП.В': 'VAR.S', 'ДИСП.Г': 'VAR.P', 'СУММКВ': 'SUMSQ',
  'ОКРУГЛТ': 'MROUND', 'ЕЛОГИЧ': 'ISLOGICAL', 'ГИПЕРССЫЛКА': 'HYPERLINK', 'СРЗНАЧА': 'AVERAGEA',
  'ПРОЦЕНТИЛЬ': 'PERCENTILE', 'КВАРТИЛЬ': 'QUARTILE', 'МОДА': 'MODE', 'ЧЁТН': 'EVEN', 'НЕЧЁТ': 'ODD',
  'ЧЕТН': 'EVEN', 'НЕЧЕТ': 'ODD', 'ИСТИНА': 'TRUE', 'ЛОЖЬ': 'FALSE',
};

/** Имя функции в каноническом (английском) виде. */
export function canonicalFn(name: string): string {
  const up = name.toUpperCase();
  return RU_FUNCTIONS[up] ?? up;
}

/** Приоритеты бинарных операторов; больше — крепче связывает. */
const PREC: Record<string, number> = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5,
};

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined { return this.toks[this.p]; }
  private next(): Tok | undefined { return this.toks[this.p++]; }

  parse(): Node {
    const n = this.expr(0);
    return n;
  }

  private expr(minPrec: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'op') break;
      const prec = PREC[t.text];
      if (prec == null || prec < minPrec) break;
      this.next();
      // ^ правоассоциативен, остальные — лево
      const right = this.expr(t.text === '^' ? prec : prec + 1);
      left = { k: 'bin', op: t.text, l: left, r: right };
    }
    return left;
  }

  private unary(): Node {
    const t = this.peek();
    if (t && t.kind === 'op' && (t.text === '-' || t.text === '+')) {
      this.next();
      return { k: 'un', op: t.text, v: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let n = this.primary();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && t.text === ':') {
        // Диапазон, записанный через пробелы. Без этого «SUM(B2 : B4)»
        // молча считался бы как «SUM(B2)» — тихо неверный результат.
        this.next();
        const rhs = this.primary();
        if (n.k === 'ref' && rhs.k === 'ref') {
          n = {
            k: 'range',
            r1: Math.min(n.r, rhs.r), c1: Math.min(n.c, rhs.c),
            r2: Math.max(n.r, rhs.r), c2: Math.max(n.c, rhs.c),
            ...(n.sh ? { sh: n.sh } : {}),
          };
          continue;
        }
        return { k: 'err', v: ERR.ref };
      }
      if (t && t.kind === 'op' && t.text === '%') { this.next(); n = { k: 'pct', v: n }; continue; }
      break;
    }
    return n;
  }

  private primary(): Node {
    const t = this.next();
    if (!t) return { k: 'err', v: ERR.value };

    switch (t.kind) {
      case 'num': return { k: 'num', v: parseFloat(t.text) };
      case 'str': return { k: 'str', v: t.text };
      case 'ref': {
        const r = parseRef(t.text);
        return r ? { k: 'ref', ...r, ...(t.sheet ? { sh: t.sheet } : {}) } : { k: 'err', v: ERR.ref };
      }
      case 'range': {
        const rg = parseRangeText(t.text);
        if (!rg) return { k: 'err', v: ERR.ref };
        return { k: 'range', ...rg, ...(t.sheet ? { sh: t.sheet } : {}) };
      }
      case 'lparen': {
        const n = this.expr(0);
        if (this.peek()?.kind === 'rparen') this.next();
        return n;
      }
      case 'name': {
        if (t.text.startsWith('#')) return { k: 'err', v: { err: t.text } };
        // Логические литералы (TRUE() / ИСТИНА() тоже допустимы)
        const fn = canonicalFn(t.text);
        if (fn === 'TRUE' || fn === 'FALSE') {
          if (this.peek()?.kind === 'lparen') { this.next(); if (this.peek()?.kind === 'rparen') this.next(); }
          return { k: 'num', v: fn === 'TRUE' ? 1 : 0 };
        }
        if (this.peek()?.kind !== 'lparen') return { k: 'err', v: ERR.name };
        this.next(); // (
        const args: Node[] = [];
        if (this.peek()?.kind !== 'rparen') {
          for (;;) {
            args.push(this.expr(0));
            const s = this.peek();
            if (s?.kind === 'sep') { this.next(); continue; }
            break;
          }
        }
        if (this.peek()?.kind === 'rparen') this.next();
        return { k: 'call', name: fn, args };
      }
      default:
        return { k: 'err', v: ERR.value };
    }
  }
}

// ─────────────────────────── Приведение типов ────────────────────────────

const flat = (v: FValue): Scalar[] => Array.isArray(v) ? v : [v];
const first = (v: FValue): Scalar => Array.isArray(v) ? (v[0] ?? '') : v;

function toNum(v: FValue): number | FErr {
  const s = first(v);
  if (isErr(s)) return s;
  if (typeof s === 'number') return s;
  if (typeof s === 'boolean') return s ? 1 : 0;
  const t = String(s).trim();
  if (t === '') return 0;
  const n = parseFloat(t.replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? ERR.value : n;
}

function toStr(v: FValue): string | FErr {
  const s = first(v);
  if (isErr(s)) return s;
  if (typeof s === 'boolean') return s ? 'ИСТИНА' : 'ЛОЖЬ';
  if (typeof s === 'number') return numToStr(s);
  return String(s);
}

function toBool(v: FValue): boolean | FErr {
  const s = first(v);
  if (isErr(s)) return s;
  if (typeof s === 'boolean') return s;
  if (typeof s === 'number') return s !== 0;
  const t = String(s).trim().toUpperCase();
  if (t === '' || t === '0' || t === 'FALSE' || t === 'ЛОЖЬ') return false;
  return true;
}

/** Число → строка без хвостов плавающей точки. */
function numToStr(n: number): string {
  if (!isFinite(n)) return isNaN(n) ? '#ЧИСЛО!' : (n > 0 ? '∞' : '-∞');
  const r = Math.round(n * 1e10) / 1e10;
  return String(r);
}

/** Только числа из списка — для SUM, AVERAGE и им подобных. */
function nums(vals: FValue[]): number[] | FErr {
  const out: number[] = [];
  for (const v of vals) {
    for (const s of flat(v)) {
      if (isErr(s)) return s;
      if (typeof s === 'number') out.push(s);
      else if (typeof s === 'boolean') out.push(s ? 1 : 0);
      else {
        const t = String(s).trim();
        if (t === '') continue;                    // пустые не участвуют
        const n = parseFloat(t.replace(/\s/g, '').replace(',', '.'));
        if (!isNaN(n)) out.push(n);
      }
    }
  }
  return out;
}

// ─────────────────────────── Критерии SUMIF/COUNTIF ──────────────────────

/** «>100», «<>абв», «Мадрид», «А*» → функция-предикат. */
function makeCriteria(crit: Scalar): (v: Scalar) => boolean {
  if (isErr(crit)) return () => false;
  const raw = typeof crit === 'string' ? crit.trim() : crit;

  if (typeof raw === 'string') {
    const m = raw.match(/^(<=|>=|<>|=|<|>)(.*)$/);
    if (m) {
      const op = m[1], operand = m[2].trim();
      const on = parseFloat(operand.replace(',', '.'));
      const isNum = operand !== '' && !isNaN(on);
      return (v: Scalar) => {
        if (isErr(v)) return false;
        if (isNum) {
          const vn = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
          if (isNaN(vn)) return op === '<>';
          switch (op) {
            case '>': return vn > on; case '>=': return vn >= on;
            case '<': return vn < on; case '<=': return vn <= on;
            case '<>': return vn !== on; default: return vn === on;
          }
        }
        const vs = String(typeof v === 'number' ? numToStr(v) : v).toLowerCase();
        const os = operand.toLowerCase();
        switch (op) {
          case '<>': return vs !== os;
          case '>': return vs > os; case '>=': return vs >= os;
          case '<': return vs < os; case '<=': return vs <= os;
          default: return vs === os;
        }
      };
    }

    // Подстановочные знаки * и ?
    if (/[*?]/.test(raw)) {
      const rx = new RegExp('^' + raw
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      return (v: Scalar) => !isErr(v) && rx.test(String(typeof v === 'number' ? numToStr(v) : v));
    }
  }

  // Равенство: числа сравниваем численно, строки — без учёта регистра
  const cn = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.'));
  const cIsNum = typeof raw === 'number' || (String(raw).trim() !== '' && !isNaN(cn));
  const cs = String(typeof raw === 'number' ? numToStr(raw) : raw).toLowerCase();
  return (v: Scalar) => {
    if (isErr(v)) return false;
    if (cIsNum) {
      const vn = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
      return !isNaN(vn) && vn === cn;
    }
    return String(typeof v === 'number' ? numToStr(v) : v).toLowerCase() === cs;
  };
}

// ─────────────────────────── Доступ к листу ──────────────────────────────

export interface GridAccess {
  /** Сырое содержимое ячейки: значение или формула с «=». */
  raw(r: number, c: number): string;
  /** Число ли это по типу ячейки (когда таблица знает тип явно). */
  isNumeric?(r: number, c: number): boolean;
  /** Сколько строк реально занято — граница для диапазонов вида A:A. */
  rowCount?(): number;
  /**
   * Другой лист книги по имени (без учёта регистра) — для ссылок «Лист!A1».
   * Должен возвращать один и тот же объект для одного листа: по нему
   * вычислители листов делят общий кэш и общую защиту от циклов.
   */
  sheet?(name: string): GridAccess | null;
}

export interface Evaluator {
  /** Вычислить формулу (с «=» или без) и вернуть текст для показа. */
  evalToString(formula: string): string;
  /** Вычислить и вернуть типизированное значение. */
  evaluate(formula: string): FValue;
  /** Значение ячейки с учётом того, что в ней может быть формула. */
  cellValue(r: number, c: number): Scalar;
}

const MAX_DEPTH = 64;

/** Вычислитель листа + служебный доступ для соседних листов той же книги. */
interface SheetEval extends Evaluator {
  rows(): number;
}

export function createEvaluator(grid: GridAccess): Evaluator {
  return makeEvaluator(grid, new Map());
}

function makeEvaluator(grid: GridAccess, registry: Map<GridAccess, SheetEval>): SheetEval {
  const cache = new Map<string, Scalar>();
  const visiting = new Set<string>();
  /** Ячейка, которая сейчас вычисляется, — для ROW()/COLUMN() без аргументов. */
  const stack: Array<{ r: number; c: number }> = [];

  /** Вычислитель листа, на который указывает ссылка; null — листа нет. */
  function target(sh?: string): SheetEval | null {
    if (!sh) return self;
    const g = grid.sheet?.(sh);
    if (!g) return null;
    if (g === grid) return self;
    return registry.get(g) ?? makeEvaluator(g, registry);
  }

  function rows(): number {
    if (grid.rowCount) return grid.rowCount();
    return 0;
  }

  function cellValue(r: number, c: number): Scalar {
    if (r < 0 || c < 0) return ERR.ref;
    const key = r + ':' + c;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (visiting.has(key)) return ERR.circ;

    const raw = grid.raw(r, c);
    if (raw === '' || raw == null) return '';

    if (raw.startsWith('=')) {
      visiting.add(key);
      stack.push({ r, c });
      let val: Scalar;
      try {
        val = first(evalNode(parse(raw.slice(1)), 0));
      } catch {
        val = ERR.value;
      } finally {
        visiting.delete(key);
        stack.pop();
      }
      cache.set(key, val);
      return val;
    }

    // Ячейка помечена числовой — доверяем типу; иначе пробуем распознать
    let val: Scalar;
    if (grid.isNumeric?.(r, c)) {
      const n = parseFloat(raw);
      val = isNaN(n) ? raw : n;
    } else {
      const t = raw.trim();
      const n = parseFloat(t.replace(',', '.'));
      val = (t !== '' && !isNaN(n) && /^-?[\d\s.,]+$/.test(t)) ? n : raw;
    }
    cache.set(key, val);
    return val;
  }

  /** Нижняя граница диапазона: у «A:A» — последняя занятая строка листа. */
  function lastRow(n: Extract<Node, { k: 'range' }>, ev: SheetEval): number {
    return n.r2 === OPEN_END ? Math.max(n.r1, ev.rows() - 1) : n.r2;
  }

  function rangeValues(n: Extract<Node, { k: 'range' }>): Scalar[] | FErr {
    const ev = target(n.sh);
    if (!ev) return ERR.ref;
    const out: Scalar[] = [];
    const r2 = lastRow(n, ev);
    for (let r = n.r1; r <= r2; r++)
      for (let c = n.c1; c <= n.c2; c++) out.push(ev.cellValue(r, c));
    return out;
  }

  /** Значение ячейки диапазона с учётом листа, на который он ссылается. */
  function at(n: Extract<Node, { k: 'range' }>, r: number, c: number): Scalar {
    const ev = target(n.sh);
    return ev ? ev.cellValue(r, c) : ERR.ref;
  }

  function parse(src: string): Node {
    return new Parser(tokenize(src)).parse();
  }

  function evalNode(n: Node, depth: number): FValue {
    if (depth > MAX_DEPTH) return ERR.circ;

    switch (n.k) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'err': return n.v;
      case 'ref': {
        const ev = target(n.sh);
        return ev ? ev.cellValue(n.r, n.c) : ERR.ref;
      }
      case 'range': return rangeValues(n);
      case 'pct': {
        const v = toNum(evalNode(n.v, depth + 1));
        return isErr(v) ? v : v / 100;
      }
      case 'un': {
        const v = toNum(evalNode(n.v, depth + 1));
        if (isErr(v)) return v;
        return n.op === '-' ? -v : v;
      }
      case 'bin': return evalBin(n, depth);
      case 'call': return evalCall(n, depth);
    }
  }

  function evalBin(n: Extract<Node, { k: 'bin' }>, depth: number): FValue {
    const L = evalNode(n.l, depth + 1);
    const R = evalNode(n.r, depth + 1);
    const ls = first(L), rs = first(R);
    if (isErr(ls)) return ls;
    if (isErr(rs)) return rs;

    if (n.op === '&') {
      const a = toStr(ls), b = toStr(rs);
      if (isErr(a)) return a; if (isErr(b)) return b;
      return a + b;
    }

    if (['=', '<>', '<', '>', '<=', '>='].includes(n.op)) {
      // Число с числом сравниваем численно, иначе — как текст без регистра
      const bothNum = typeof ls === 'number' && typeof rs === 'number';
      let cmp: number;
      if (bothNum) cmp = (ls as number) - (rs as number);
      else {
        const a = String(typeof ls === 'number' ? numToStr(ls) : ls).toLowerCase();
        const b = String(typeof rs === 'number' ? numToStr(rs) : rs).toLowerCase();
        cmp = a < b ? -1 : a > b ? 1 : 0;
      }
      switch (n.op) {
        case '=':  return cmp === 0;
        case '<>': return cmp !== 0;
        case '<':  return cmp < 0;
        case '>':  return cmp > 0;
        case '<=': return cmp <= 0;
        default:   return cmp >= 0;
      }
    }

    const a = toNum(ls), b = toNum(rs);
    if (isErr(a)) return a; if (isErr(b)) return b;
    switch (n.op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? ERR.div0 : a / b;
      case '^': return Math.pow(a, b);
      default:  return ERR.value;
    }
  }

  // ── Функции ────────────────────────────────────────────────────────────

  function evalCall(n: Extract<Node, { k: 'call' }>, depth: number): FValue {
    const name = n.name;
    const A = () => n.args.map(a => evalNode(a, depth + 1));

    // Ленивые функции — аргументы вычисляем не все
    switch (name) {
      case 'IF': {
        const c = toBool(evalNode(n.args[0], depth + 1));
        if (isErr(c)) return c;
        if (c) return n.args[1] ? evalNode(n.args[1], depth + 1) : true;
        return n.args[2] ? evalNode(n.args[2], depth + 1) : false;
      }
      case 'IFS': {
        for (let i = 0; i + 1 < n.args.length; i += 2) {
          const c = toBool(evalNode(n.args[i], depth + 1));
          if (isErr(c)) return c;
          if (c) return evalNode(n.args[i + 1], depth + 1);
        }
        return ERR.na;
      }
      case 'IFERROR': {
        const v = evalNode(n.args[0], depth + 1);
        return isErr(first(v)) ? evalNode(n.args[1], depth + 1) : v;
      }
      case 'IFNA': {
        const v = evalNode(n.args[0], depth + 1);
        const s = first(v);
        return (isErr(s) && s.err === '#N/A') ? evalNode(n.args[1], depth + 1) : v;
      }
      case 'AND': {
        for (const v of A()) for (const s of flat(v)) {
          const b = toBool(s); if (isErr(b)) return b; if (!b) return false;
        }
        return true;
      }
      case 'OR': {
        for (const v of A()) for (const s of flat(v)) {
          const b = toBool(s); if (isErr(b)) return b; if (b) return true;
        }
        return false;
      }
      case 'NOT': { const b = toBool(evalNode(n.args[0], depth + 1)); return isErr(b) ? b : !b; }
      case 'XOR': {
        let cnt = 0;
        for (const v of A()) for (const s of flat(v)) { const b = toBool(s); if (isErr(b)) return b; if (b) cnt++; }
        return cnt % 2 === 1;
      }
    }

    const args = A();
    const a0 = args[0], a1 = args[1], a2 = args[2];

    const num1 = (fn: (x: number) => number): FValue => {
      const x = toNum(a0); return isErr(x) ? x : fn(x);
    };
    const agg = (fn: (list: number[]) => number): FValue => {
      const list = nums(args); return isErr(list) ? list : fn(list);
    };

    switch (name) {
      // ── Агрегаты ──────────────────────────────────────────────────────
      case 'SUM':     return agg(l => l.reduce((s, v) => s + v, 0));
      case 'PRODUCT': return agg(l => l.reduce((s, v) => s * v, 1));
      case 'AVERAGE': case 'AVG': return agg(l => l.length ? l.reduce((s, v) => s + v, 0) / l.length : 0);
      case 'MIN':     return agg(l => l.length ? Math.min(...l) : 0);
      case 'MAX':     return agg(l => l.length ? Math.max(...l) : 0);
      case 'COUNT':   return agg(l => l.length);
      case 'MEDIAN':  return agg(l => {
        if (!l.length) return 0;
        const s = [...l].sort((x, y) => x - y), m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      });
      case 'STDEV': case 'STDEVA': return agg(l => {
        if (l.length < 2) return 0;
        const m = l.reduce((s, v) => s + v, 0) / l.length;
        return Math.sqrt(l.reduce((s, v) => s + (v - m) ** 2, 0) / (l.length - 1));
      });
      case 'COUNTA':
        return args.reduce<number>((acc, v) =>
          acc + flat(v).filter(s => !(typeof s === 'string' && s.trim() === '')).length, 0);
      case 'COUNTBLANK':
        return args.reduce<number>((acc, v) =>
          acc + flat(v).filter(s => typeof s === 'string' && s.trim() === '').length, 0);
      case 'SUMPRODUCT': {
        const lists = args.map(v => flat(v));
        const len = Math.min(...lists.map(l => l.length));
        let s = 0;
        for (let i = 0; i < len; i++) {
          let p = 1;
          for (const l of lists) { const x = toNum(l[i]); if (isErr(x)) return x; p *= x; }
          s += p;
        }
        return s;
      }

      // ── Условные агрегаты ─────────────────────────────────────────────
      case 'COUNTIF': {
        const pred = makeCriteria(first(a1));
        return flat(a0).filter(pred).length;
      }
      case 'SUMIF': case 'AVERAGEIF': {
        const range = flat(a0), pred = makeCriteria(first(a1));
        const sumRange = a2 !== undefined ? flat(a2) : range;
        let s = 0, cnt = 0;
        for (let i = 0; i < range.length; i++) {
          if (!pred(range[i])) continue;
          const cell = sumRange[i];
          if (isErr(cell)) return cell;
          // Пустые и нечисловые ячейки в среднее не входят — иначе
          // AVERAGEIF занижал бы результат, считая пустоту нулём.
          if (cell === undefined || cell === '' || typeof cell === 'string') {
            const parsed = typeof cell === 'string' && cell.trim() !== ''
              ? parseFloat(cell.replace(',', '.')) : NaN;
            if (isNaN(parsed)) continue;
            s += parsed; cnt++; continue;
          }
          const x = toNum(cell);
          if (isErr(x)) return x;
          s += x; cnt++;
        }
        if (name === 'SUMIF') return s;
        return cnt ? s / cnt : ERR.div0;
      }
      case 'COUNTIFS': case 'SUMIFS': case 'AVERAGEIFS': case 'MAXIFS': case 'MINIFS': {
        // SUMIFS(sum; r1; c1; r2; c2…) — у SUM/AVG/MAX/MIN первым идёт диапазон значений
        const valueFirst = name !== 'COUNTIFS';
        const target = valueFirst ? flat(a0) : null;
        const pairsFrom = valueFirst ? 1 : 0;
        const pairs: Array<{ range: Scalar[]; pred: (v: Scalar) => boolean }> = [];
        for (let i = pairsFrom; i + 1 < args.length; i += 2)
          pairs.push({ range: flat(args[i]), pred: makeCriteria(first(args[i + 1])) });
        if (!pairs.length) return ERR.value;

        const len = Math.max(...pairs.map(p => p.range.length));
        const picked: number[] = [];
        let count = 0;
        for (let i = 0; i < len; i++) {
          if (!pairs.every(p => p.pred(p.range[i] ?? ''))) continue;
          count++;
          if (target) { const x = toNum(target[i] ?? 0); if (isErr(x)) return x; picked.push(x); }
        }
        switch (name) {
          case 'COUNTIFS':   return count;
          case 'SUMIFS':     return picked.reduce((s, v) => s + v, 0);
          case 'AVERAGEIFS': return picked.length ? picked.reduce((s, v) => s + v, 0) / picked.length : ERR.div0;
          case 'MAXIFS':     return picked.length ? Math.max(...picked) : 0;
          default:           return picked.length ? Math.min(...picked) : 0;
        }
      }

      // ── Поиск ─────────────────────────────────────────────────────────
      case 'VLOOKUP': case 'HLOOKUP': {
        const rangeNode = n.args[1];
        if (!rangeNode || rangeNode.k !== 'range') return ERR.ref;
        const idx = toNum(a2); if (isErr(idx)) return idx;
        // Четвёртый аргумент: ЛОЖЬ/0 — точное совпадение, ИСТИНА/пусто — приблизительное
        // (как в Excel: последняя строка, где ключ ≤ искомого, при сортировке по возрастанию).
        const approx = n.args[3] === undefined ? false : toBool(evalNode(n.args[3], depth + 1)) === true;
        const key = first(a0);
        const pred = makeCriteria(typeof key === 'string' ? key.replace(/^([<>=])/, '=$1') : key);
        const ev = target(rangeNode.sh);
        if (!ev) return ERR.ref;
        const { r1, c1, c2 } = rangeNode;
        const r2 = lastRow(rangeNode, ev);
        const vert = name === 'VLOOKUP';
        const len = vert ? r2 - r1 + 1 : c2 - c1 + 1;
        const keyAt = (i: number) => vert ? ev.cellValue(r1 + i, c1) : ev.cellValue(r1, c1 + i);
        const resultAt = (i: number) => {
          if (vert) { const col = c1 + idx - 1; return col > c2 ? ERR.ref : ev.cellValue(r1 + i, col); }
          const row = r1 + idx - 1; return row > r2 ? ERR.ref : ev.cellValue(row, c1 + i);
        };
        if (approx && typeof key === 'number') {
          let hit = -1;
          for (let i = 0; i < len; i++) {
            const k = keyAt(i);
            if (typeof k === 'number' && k <= key) hit = i;
            else if (typeof k === 'number' && k > key) break;
          }
          return hit < 0 ? ERR.na : resultAt(hit);
        }
        for (let i = 0; i < len; i++) if (pred(keyAt(i))) return resultAt(i);
        return ERR.na;
      }
      case 'MATCH': {
        const pred = makeCriteria(first(a0));
        const list = flat(a1);
        const i = list.findIndex(pred);
        return i < 0 ? ERR.na : i + 1;
      }
      case 'INDEX': {
        const rangeNode = n.args[0];
        const rowN = toNum(a1); if (isErr(rowN)) return rowN;
        if (rangeNode?.k === 'range') {
          const colN = a2 !== undefined ? toNum(a2) : 1;
          if (isErr(colN)) return colN;
          const ev = target(rangeNode.sh);
          if (!ev) return ERR.ref;
          const { r1, c1, c2 } = rangeNode;
          const r2 = lastRow(rangeNode, ev);
          // Одномерный диапазон адресуется одним индексом
          if (r1 === r2 && a2 === undefined) return at(rangeNode, r1, c1 + rowN - 1);
          if (c1 === c2 && a2 === undefined) return at(rangeNode, r1 + rowN - 1, c1);
          const r = r1 + rowN - 1, c = c1 + colN - 1;
          return (r > r2 || c > c2) ? ERR.ref : at(rangeNode, r, c);
        }
        const list = flat(a0);
        return list[rowN - 1] ?? ERR.ref;
      }
      case 'XLOOKUP': {
        const pred = makeCriteria(first(a0));
        const lookup = flat(a1), ret = flat(a2);
        const i = lookup.findIndex(pred);
        if (i < 0) return args[3] !== undefined ? args[3] : ERR.na;
        return ret[i] ?? ERR.na;
      }
      case 'CHOOSE': {
        const i = toNum(a0); if (isErr(i)) return i;
        return args[i] ?? ERR.value;
      }

      // ── Математика ────────────────────────────────────────────────────
      case 'ABS':   return num1(Math.abs);
      case 'SQRT':  return num1(x => x < 0 ? NaN : Math.sqrt(x));
      case 'INT':   return num1(Math.floor);
      case 'SIGN':  return num1(Math.sign);
      case 'EXP':   return num1(Math.exp);
      case 'LN':    return num1(Math.log);
      case 'LOG10': return num1(Math.log10);
      case 'PI':    return Math.PI;
      case 'RAND':  return Math.random();
      case 'TRUNC': {
        const x = toNum(a0); if (isErr(x)) return x;
        const d = a1 !== undefined ? toNum(a1) : 0; if (isErr(d)) return d;
        const p = Math.pow(10, d);
        return Math.trunc(x * p) / p;
      }
      case 'LOG': {
        const x = toNum(a0); if (isErr(x)) return x;
        const b = a1 !== undefined ? toNum(a1) : 10; if (isErr(b)) return b;
        return Math.log(x) / Math.log(b);
      }
      case 'POWER': { const x = toNum(a0), y = toNum(a1); if (isErr(x)) return x; if (isErr(y)) return y; return Math.pow(x, y); }
      case 'MOD':   { const x = toNum(a0), y = toNum(a1); if (isErr(x)) return x; if (isErr(y)) return y; return y === 0 ? ERR.div0 : x - y * Math.floor(x / y); }
      case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': {
        const x = toNum(a0); if (isErr(x)) return x;
        const d = a1 !== undefined ? toNum(a1) : 0; if (isErr(d)) return d;
        const p = Math.pow(10, d);
        const f = name === 'ROUND' ? Math.round : name === 'ROUNDUP' ? Math.ceil : Math.floor;
        return (x < 0 && name !== 'ROUND' ? -f(-x * p) : f(x * p)) / p;
      }
      case 'CEILING': case 'FLOOR': {
        const x = toNum(a0); if (isErr(x)) return x;
        const step = a1 !== undefined ? toNum(a1) : 1; if (isErr(step)) return step;
        if (step === 0) return 0;
        return (name === 'CEILING' ? Math.ceil : Math.floor)(x / step) * step;
      }
      case 'RANDBETWEEN': {
        const lo = toNum(a0), hi = toNum(a1);
        if (isErr(lo)) return lo; if (isErr(hi)) return hi;
        return Math.floor(lo + Math.random() * (hi - lo + 1));
      }

      // ── Текст ─────────────────────────────────────────────────────────
      case 'CONCATENATE': case 'CONCAT': {
        let s = '';
        for (const v of args) for (const x of flat(v)) { const t = toStr(x); if (isErr(t)) return t; s += t; }
        return s;
      }
      case 'TEXTJOIN': {
        const sep = toStr(a0); if (isErr(sep)) return sep;
        const skipEmpty = a1 === undefined ? true : toBool(a1) === true;
        const parts: string[] = [];
        for (const v of args.slice(2)) for (const x of flat(v)) {
          const t = toStr(x); if (isErr(t)) return t;
          if (skipEmpty && t === '') continue;
          parts.push(t);
        }
        return parts.join(sep);
      }
      case 'LEN':   { const s = toStr(a0); return isErr(s) ? s : s.length; }
      case 'UPPER': { const s = toStr(a0); return isErr(s) ? s : s.toUpperCase(); }
      case 'LOWER': { const s = toStr(a0); return isErr(s) ? s : s.toLowerCase(); }
      case 'TRIM':  { const s = toStr(a0); return isErr(s) ? s : s.trim().replace(/\s+/g, ' '); }
      case 'PROPER': {
        const s = toStr(a0); if (isErr(s)) return s;
        return s.replace(/(^|\s|-)(\S)/g, (_m, p, ch) => p + ch.toUpperCase());
      }
      case 'LEFT': case 'RIGHT': {
        const s = toStr(a0); if (isErr(s)) return s;
        const k = a1 !== undefined ? toNum(a1) : 1; if (isErr(k)) return k;
        return name === 'LEFT' ? s.slice(0, k) : (k <= 0 ? '' : s.slice(-k));
      }
      case 'MID': {
        const s = toStr(a0); if (isErr(s)) return s;
        const st = toNum(a1), ln = toNum(a2);
        if (isErr(st)) return st; if (isErr(ln)) return ln;
        return s.slice(Math.max(0, st - 1), Math.max(0, st - 1) + ln);
      }
      case 'REPT': {
        const s = toStr(a0); if (isErr(s)) return s;
        const k = toNum(a1); if (isErr(k)) return k;
        return k > 0 ? s.repeat(Math.min(k, 10000)) : '';
      }
      case 'SUBSTITUTE': {
        const s = toStr(a0), find = toStr(a1), rep = toStr(a2);
        if (isErr(s)) return s; if (isErr(find)) return find; if (isErr(rep)) return rep;
        if (find === '') return s;
        if (args[3] !== undefined) {
          const nth = toNum(args[3]); if (isErr(nth)) return nth;
          let idx = -1, count = 0;
          while (count < nth) { idx = s.indexOf(find, idx + 1); if (idx < 0) return s; count++; }
          return s.slice(0, idx) + rep + s.slice(idx + find.length);
        }
        return s.split(find).join(rep);
      }
      case 'REPLACE': {
        const s = toStr(a0); if (isErr(s)) return s;
        const st = toNum(a1), ln = toNum(a2), rep = toStr(args[3]);
        if (isErr(st)) return st; if (isErr(ln)) return ln; if (isErr(rep)) return rep;
        return s.slice(0, st - 1) + rep + s.slice(st - 1 + ln);
      }
      case 'FIND': case 'SEARCH': {
        const needle = toStr(a0), hay = toStr(a1);
        if (isErr(needle)) return needle; if (isErr(hay)) return hay;
        const from = args[2] !== undefined ? toNum(args[2]) : 1;
        if (isErr(from)) return from;
        const i = name === 'FIND'
          ? hay.indexOf(needle, from - 1)
          : hay.toLowerCase().indexOf(needle.toLowerCase(), from - 1);
        return i < 0 ? ERR.value : i + 1;
      }
      case 'EXACT': { const a = toStr(a0), b = toStr(a1); if (isErr(a)) return a; if (isErr(b)) return b; return a === b; }
      case 'VALUE': { const x = toNum(a0); return x; }
      case 'TEXT': {
        const x = toNum(a0); if (isErr(x)) return x;
        const f = toStr(a1); if (isErr(f)) return f;
        const dec = f.match(/\.([0#]+)/)?.[1].length ?? 0;
        if (f.includes('%')) return (x * 100).toFixed(dec) + '%';
        const s = x.toFixed(dec);
        return f.includes(',') ? s.replace(/\B(?=(\d{3})+(?!\d))/, ' ') : s;
      }

      // ── Даты ──────────────────────────────────────────────────────────
      case 'TODAY': { const d = new Date(); return dateToSerial(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))); }
      case 'NOW':   { const d = new Date(); return dateToSerial(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()))); }
      case 'DATE': {
        const y = toNum(a0), m = toNum(a1), d = toNum(a2);
        if (isErr(y)) return y; if (isErr(m)) return m; if (isErr(d)) return d;
        return dateToSerial(new Date(Date.UTC(y, m - 1, d)));
      }
      case 'YEAR': case 'MONTH': case 'DAY': case 'HOUR': case 'MINUTE': case 'SECOND': case 'WEEKDAY': {
        const x = toNum(a0); if (isErr(x)) return x;
        const d = serialToDate(x);
        switch (name) {
          case 'YEAR':   return d.getUTCFullYear();
          case 'MONTH':  return d.getUTCMonth() + 1;
          case 'DAY':    return d.getUTCDate();
          case 'HOUR':   return d.getUTCHours();
          case 'MINUTE': return d.getUTCMinutes();
          case 'SECOND': return d.getUTCSeconds();
          default:       return d.getUTCDay() + 1;
        }
      }
      case 'DAYS': { const b = toNum(a0), a = toNum(a1); if (isErr(a)) return a; if (isErr(b)) return b; return b - a; }
      case 'EDATE': case 'EOMONTH': {
        const x = toNum(a0), k = toNum(a1);
        if (isErr(x)) return x; if (isErr(k)) return k;
        const d = serialToDate(x);
        const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k + (name === 'EOMONTH' ? 1 : 0),
          name === 'EOMONTH' ? 0 : d.getUTCDate()));
        return dateToSerial(t);
      }
      case 'DATEDIF': {
        const s = toNum(a0), e = toNum(a1); const unit = toStr(a2);
        if (isErr(s)) return s; if (isErr(e)) return e; if (isErr(unit)) return unit;
        const ds = serialToDate(s), de = serialToDate(e);
        const u = unit.toUpperCase();
        if (u === 'D') return e - s;
        let months = (de.getUTCFullYear() - ds.getUTCFullYear()) * 12 + (de.getUTCMonth() - ds.getUTCMonth());
        if (de.getUTCDate() < ds.getUTCDate()) months--;
        if (u === 'M') return months;
        if (u === 'Y') return Math.floor(months / 12);
        return ERR.num;
      }

      // ── Информационные ────────────────────────────────────────────────
      case 'ISBLANK':  { const s = first(a0); return typeof s === 'string' && s === ''; }
      case 'ISNUMBER': { const s = first(a0); return typeof s === 'number'; }
      case 'ISTEXT':   { const s = first(a0); return typeof s === 'string' && s !== ''; }
      case 'ISERROR':  return isErr(first(a0));
      case 'ISNA':     { const s = first(a0); return isErr(s) && s.err === '#N/A'; }
      case 'NA':       return ERR.na;
      case 'N':        { const x = toNum(a0); return isErr(x) ? 0 : x; }
      case 'T':        { const s = first(a0); return typeof s === 'string' ? s : ''; }
      case 'ISLOGICAL': return typeof first(a0) === 'boolean';
      case 'ISEVEN': case 'ISODD': {
        const x = toNum(a0); if (isErr(x)) return x;
        const even = Math.trunc(x) % 2 === 0;
        return name === 'ISEVEN' ? even : !even;
      }

      // ── Позиция и размер ──────────────────────────────────────────────
      case 'ROW': case 'COLUMN': {
        const nd = n.args[0];
        if (!nd) { const cur = stack[stack.length - 1]; return cur ? (name === 'ROW' ? cur.r + 1 : cur.c + 1) : ERR.value; }
        if (nd.k === 'ref') return name === 'ROW' ? nd.r + 1 : nd.c + 1;
        if (nd.k === 'range') return name === 'ROW' ? nd.r1 + 1 : nd.c1 + 1;
        return ERR.value;
      }
      case 'ROWS': case 'COLUMNS': {
        const nd = n.args[0];
        if (nd?.k === 'ref') return 1;
        if (nd?.k === 'range') {
          const ev = target(nd.sh); if (!ev) return ERR.ref;
          return name === 'ROWS' ? lastRow(nd, ev) - nd.r1 + 1 : nd.c2 - nd.c1 + 1;
        }
        return Array.isArray(a0) ? (name === 'ROWS' ? a0.length : 1) : 1;
      }

      // ── Статистика ────────────────────────────────────────────────────
      case 'LARGE': case 'SMALL': {
        const list = nums([a0]); if (isErr(list)) return list;
        const k = toNum(a1); if (isErr(k)) return k;
        const s = [...list].sort((x, y) => name === 'LARGE' ? y - x : x - y);
        return k >= 1 && k <= s.length ? s[Math.floor(k) - 1] : ERR.num;
      }
      case 'RANK': case 'RANK.EQ': {
        const x = toNum(a0); if (isErr(x)) return x;
        const list = nums([a1]); if (isErr(list)) return list;
        const asc = a2 !== undefined && toBool(a2) === true;
        if (!list.includes(x)) return ERR.na;
        return 1 + list.filter(v => asc ? v < x : v > x).length;
      }
      case 'VAR': case 'VAR.S': case 'VAR.P': case 'STDEV.S': case 'STDEV.P': case 'STDEVP': {
        const list = nums(args); if (isErr(list)) return list;
        const pop = name.endsWith('.P') || name === 'STDEVP';
        if (list.length < (pop ? 1 : 2)) return ERR.div0;
        const m = list.reduce((s, v) => s + v, 0) / list.length;
        const v = list.reduce((s, x) => s + (x - m) ** 2, 0) / (list.length - (pop ? 0 : 1));
        return name.startsWith('VAR') ? v : Math.sqrt(v);
      }
      case 'SUMSQ': return agg(l => l.reduce((s, v) => s + v * v, 0));
      case 'AVERAGEA': {
        let s = 0, cnt = 0;
        for (const v of args) for (const x of flat(v)) {
          if (isErr(x)) return x;
          if (typeof x === 'string' && x.trim() === '') continue;
          s += typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : 0; cnt++;
        }
        return cnt ? s / cnt : ERR.div0;
      }
      case 'MODE': {
        const list = nums(args); if (isErr(list)) return list;
        const cnt = new Map<number, number>();
        let best = NaN, bestN = 1;
        for (const v of list) { const k = (cnt.get(v) ?? 0) + 1; cnt.set(v, k); if (k > bestN) { bestN = k; best = v; } }
        return isNaN(best) ? ERR.na : best;
      }
      case 'PERCENTILE': case 'QUARTILE': {
        const list = nums([a0]); if (isErr(list)) return list;
        let p = toNum(a1); if (isErr(p)) return p;
        if (name === 'QUARTILE') p = p / 4;
        if (!list.length || p < 0 || p > 1) return ERR.num;
        const s = [...list].sort((x, y) => x - y);
        const pos = p * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
        return s[lo] + (s[hi] - s[lo]) * (pos - lo);
      }
      case 'SUBTOTAL': {
        const fnum = toNum(a0); if (isErr(fnum)) return fnum;
        const code = Math.trunc(fnum) % 100;
        const rest = args.slice(1);
        const list = nums(rest); if (isErr(list)) return list;
        const sum = list.reduce((s, v) => s + v, 0);
        switch (code) {
          case 1: return list.length ? sum / list.length : ERR.div0;
          case 2: return list.length;
          case 3: return rest.reduce<number>((acc, v) => acc + flat(v).filter(s => !(typeof s === 'string' && s.trim() === '')).length, 0);
          case 4: return list.length ? Math.max(...list) : 0;
          case 5: return list.length ? Math.min(...list) : 0;
          case 6: return list.reduce((s, v) => s * v, 1);
          case 9: return sum;
          default: return ERR.value;
        }
      }

      // ── Математика (дополнение) ───────────────────────────────────────
      case 'QUOTIENT': {
        const x = toNum(a0), y = toNum(a1); if (isErr(x)) return x; if (isErr(y)) return y;
        return y === 0 ? ERR.div0 : Math.trunc(x / y);
      }
      case 'MROUND': {
        const x = toNum(a0), m = toNum(a1); if (isErr(x)) return x; if (isErr(m)) return m;
        return m === 0 ? 0 : Math.round(x / m) * m;
      }
      case 'EVEN': case 'ODD': {
        const x = toNum(a0); if (isErr(x)) return x;
        const sgn = x < 0 ? -1 : 1; let v = Math.ceil(Math.abs(x));
        if (name === 'EVEN' && v % 2) v++;
        if (name === 'ODD' && v % 2 === 0) v++;
        return sgn * v;
      }

      // ── Текст (дополнение) ────────────────────────────────────────────
      case 'CHAR': { const x = toNum(a0); return isErr(x) ? x : String.fromCharCode(x); }
      case 'CODE': { const s = toStr(a0); return isErr(s) ? s : (s.length ? s.charCodeAt(0) : ERR.value); }
      // eslint-disable-next-line no-control-regex
      case 'CLEAN': { const s = toStr(a0); return isErr(s) ? s : s.replace(/[\x00-\x1f]/g, ''); }
      case 'HYPERLINK': { const s = toStr(a1 !== undefined ? a1 : a0); return s; }

      // ── Даты (дополнение) ─────────────────────────────────────────────
      case 'WEEKNUM': {
        const x = toNum(a0); if (isErr(x)) return x;
        const d = serialToDate(x);
        const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const type = a1 !== undefined ? toNum(a1) : 1; if (isErr(type)) return type;
        const startDow = type === 2 ? 1 : 0;
        const offset = (jan1.getUTCDay() - startDow + 7) % 7;
        const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
        return Math.floor((dayOfYear + offset) / 7) + 1;
      }
      case 'NETWORKDAYS': {
        const s = toNum(a0), e = toNum(a1); if (isErr(s)) return s; if (isErr(e)) return e;
        const holidays = new Set((a2 !== undefined ? flat(a2) : []).filter(v => typeof v === 'number').map(v => Math.floor(v as number)));
        const from = Math.floor(Math.min(s, e)), to = Math.floor(Math.max(s, e));
        let cnt = 0;
        for (let x = from; x <= to; x++) {
          const dow = serialToDate(x).getUTCDay();
          if (dow !== 0 && dow !== 6 && !holidays.has(x)) cnt++;
        }
        return s <= e ? cnt : -cnt;
      }

      default: return ERR.name;
    }
  }

  function evaluate(formula: string): FValue {
    const src = formula.startsWith('=') ? formula.slice(1) : formula;
    try {
      return evalNode(parse(src), 0);
    } catch {
      return ERR.value;
    }
  }

  function evalToString(formula: string): string {
    const v = first(evaluate(formula));
    if (isErr(v)) return v.err;
    if (typeof v === 'number') return numToStr(v);
    if (typeof v === 'boolean') return v ? 'ИСТИНА' : 'ЛОЖЬ';
    return v;
  }

  const self: SheetEval = { evaluate, evalToString, cellValue, rows };
  registry.set(grid, self);
  return self;
}

/** Список функций для автодополнения в строке формул. */
export const FUNCTION_NAMES = [
  'SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','COUNTBLANK','PRODUCT','MEDIAN','STDEV','SUMPRODUCT',
  'COUNTIF','COUNTIFS','SUMIF','SUMIFS','AVERAGEIF','AVERAGEIFS','MAXIFS','MINIFS',
  'IF','IFS','IFERROR','IFNA','AND','OR','NOT','XOR',
  'VLOOKUP','HLOOKUP','XLOOKUP','INDEX','MATCH','CHOOSE',
  'ABS','ROUND','ROUNDUP','ROUNDDOWN','CEILING','FLOOR','INT','TRUNC','SQRT','POWER','MOD','SIGN',
  'EXP','LN','LOG','LOG10','PI','RAND','RANDBETWEEN',
  'CONCATENATE','CONCAT','TEXTJOIN','LEN','LEFT','RIGHT','MID','TRIM','UPPER','LOWER','PROPER',
  'SUBSTITUTE','REPLACE','FIND','SEARCH','EXACT','REPT','TEXT','VALUE',
  'TODAY','NOW','DATE','YEAR','MONTH','DAY','HOUR','MINUTE','SECOND','WEEKDAY','DAYS','EDATE','EOMONTH','DATEDIF',
  'ISBLANK','ISNUMBER','ISTEXT','ISERROR','ISNA','NA','N','T',
  'ISLOGICAL','ISEVEN','ISODD','ROW','COLUMN','ROWS','COLUMNS','LARGE','SMALL','RANK','RANK.EQ',
  'VAR','VAR.S','VAR.P','STDEV.S','STDEV.P','SUMSQ','AVERAGEA','MODE','PERCENTILE','QUARTILE','SUBTOTAL',
  'QUOTIENT','MROUND','EVEN','ODD','CHAR','CODE','CLEAN','HYPERLINK','WEEKNUM','NETWORKDAYS',
];

// ─────────────────────────── Перезапись формул ───────────────────────────
//
// Формула хранится текстом. Вставка/удаление строк, автозаполнение,
// копирование и выгрузка в .xlsx требуют переписать в ней ссылки или имена —
// делаем это по токенам, а не регулярками по тексту, чтобы не задеть
// строки в кавычках и имена функций.

/** Имя листа в виде, пригодном для формулы: кавычки, если есть пробелы и т.п. */
export function quoteSheet(name: string): string {
  return /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_.]*$/.test(name) && !CELL_RE.test(name)
    ? name : `'${name.replace(/'/g, "''")}'`;
}

function emitTokens(toks: Tok[], mapRef: (t: Tok) => string, sep?: string): string {
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    switch (t.kind) {
      case 'str': out += '"' + t.text.replace(/"/g, '""') + '"'; break;
      case 'ref': case 'range': out += mapRef(t); break;
      case 'sep': out += sep ?? t.text; break;
      case 'name': out += t.text; break;
      default: out += t.text;
    }
  }
  return out;
}

/**
 * Формула в виде, который понимает файл .xlsx: английские имена функций,
 * запятая между аргументами, без ведущего «=».
 */
export function toExcelFormula(formula: string): string {
  const src = formula.startsWith('=') ? formula.slice(1) : formula;
  const toks = tokenize(src);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'name') {
      const fn = canonicalFn(t.text);
      // Литералы ИСТИНА/ЛОЖЬ без скобок — тоже по-английски
      t.text = fn;
    }
  }
  return emitTokens(toks, t => (t.sheet ? quoteSheet(t.sheet) + '!' : '') + t.text, ',');
}

/** Сдвинуть одну адресную часть «$A$1» на dr/dc, уважая знаки $. */
function shiftAddr(addr: string, f: (r: number | null, c: number, absR: boolean, absC: boolean) => { r: number | null; c: number } | null): string | null {
  const cell = addr.match(/^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/);
  if (cell) {
    const res = f(+cell[4] - 1, letterToCol(cell[2]), cell[3] === '$', cell[1] === '$');
    if (!res || res.r === null || res.r < 0 || res.c < 0) return null;
    return `${cell[1]}${colToLetter(res.c)}${cell[3]}${res.r + 1}`;
  }
  const col = addr.match(/^(\$?)([A-Za-z]{1,3})$/);
  if (col) {
    const res = f(null, letterToCol(col[2]), false, col[1] === '$');
    if (!res || res.c < 0) return null;
    return `${col[1]}${colToLetter(res.c)}`;
  }
  return addr;
}

/**
 * Относительный сдвиг формулы при копировании/автозаполнении: =A1+$B$1,
 * скопированная на строку ниже, становится =A2+$B$1 — как в Excel.
 */
export function offsetFormula(formula: string, dr: number, dc: number): string {
  if (!formula.startsWith('=') || (!dr && !dc)) return formula;
  const toks = tokenize(formula.slice(1));
  const body = emitTokens(toks, t => {
    const parts = t.text.split(':').map(p => shiftAddr(p, (r, c, absR, absC) => ({
      r: r === null ? null : absR ? r : r + dr,
      c: absC ? c : c + dc,
    })));
    if (parts.some(p => p === null)) return '#REF!';
    return (t.sheet ? quoteSheet(t.sheet) + '!' : '') + parts.join(':');
  });
  return '=' + body;
}

/**
 * Вставка/удаление строк или колонок: ссылки, указывающие за точку вставки,
 * сдвигаются (и абсолютные тоже — Excel поступает так же). Ссылка на
 * удалённую ячейку превращается в #REF!.
 *
 * onSheet — сравнение имени листа ссылки с изменяемым листом; ссылки без
 * имени листа относятся к листу формулы (formulaOnSheet).
 */
export function shiftFormulaRefs(
  formula: string,
  op: { axis: 'row' | 'col'; at: number; count: number },
  formulaOnSheet: boolean,
  onSheet: (name: string) => boolean,
): string {
  if (!formula.startsWith('=')) return formula;
  const toks = tokenize(formula.slice(1));
  let changed = false;
  const body = emitTokens(toks, t => {
    const affected = t.sheet ? onSheet(t.sheet) : formulaOnSheet;
    const prefix = t.sheet ? quoteSheet(t.sheet) + '!' : '';
    if (!affected) return prefix + t.text;
    const ends = t.text.split(':');
    const isRange = ends.length === 2;
    const mapped = ends.map((p, idx) => shiftAddr(p, (r, c) => {
      const v = op.axis === 'row' ? r : c;
      if (v === null) return { r, c };                      // колонка целиком при сдвиге строк
      let nv = v;
      if (op.count > 0) { if (v >= op.at) nv = v + op.count; }
      else {
        const del = -op.count;
        if (v >= op.at + del) nv = v - del;
        else if (v >= op.at) {
          // Конец диапазона внутри удалённого куска стягиваем, одиночная ссылка — #REF!
          if (!isRange) return null;
          nv = idx === 0 ? op.at : op.at - 1;
        }
      }
      if (nv !== v) changed = true;
      return op.axis === 'row' ? { r: nv, c } : { r, c: nv };
    }));
    if (mapped.some(p => p === null)) { changed = true; return '#REF!'; }
    return prefix + mapped.join(':');
  });
  return changed ? '=' + body : formula;
}

/** Переименование листа: «'Старое имя'!A1» → «Новое!A1». */
export function renameSheetInFormula(formula: string, from: string, to: string): string {
  if (!formula.startsWith('=')) return formula;
  const toks = tokenize(formula.slice(1));
  const low = from.toLowerCase();
  if (!toks.some(t => t.sheet && t.sheet.toLowerCase() === low)) return formula;
  return '=' + emitTokens(toks, t =>
    (t.sheet ? quoteSheet(t.sheet.toLowerCase() === low ? to : t.sheet) + '!' : '') + t.text);
}
