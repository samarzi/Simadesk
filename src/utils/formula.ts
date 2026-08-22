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
interface Tok { kind: TokKind; text: string }

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
      if (/[eE]/.test(src[i] ?? '') && /[0-9+\-]/.test(src[i + 1] ?? '')) {
        s += src[i++];
        if (/[+\-]/.test(src[i])) s += src[i++];
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

    // Ссылка, диапазон или имя функции. $ в адресах допускается и игнорируется.
    if (/[A-Za-zА-Яа-я_$]/.test(ch)) {
      let s = '';
      while (i < src.length && /[A-Za-zА-Яа-я0-9_.$]/.test(src[i])) s += src[i++];

      const refRe = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;
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

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ref'; r: number; c: number }
  | { k: 'range'; r1: number; c1: number; r2: number; c2: number }
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
        return r ? { k: 'ref', ...r } : { k: 'err', v: ERR.ref };
      }
      case 'range': {
        const [a, b] = t.text.split(':');
        const ra = parseRef(a), rb = parseRef(b);
        if (!ra || !rb) return { k: 'err', v: ERR.ref };
        return {
          k: 'range',
          r1: Math.min(ra.r, rb.r), c1: Math.min(ra.c, rb.c),
          r2: Math.max(ra.r, rb.r), c2: Math.max(ra.c, rb.c),
        };
      }
      case 'lparen': {
        const n = this.expr(0);
        if (this.peek()?.kind === 'rparen') this.next();
        return n;
      }
      case 'name': {
        // Логические литералы
        if (t.text === 'TRUE' || t.text === 'ИСТИНА') return { k: 'num', v: 1 };
        if (t.text === 'FALSE' || t.text === 'ЛОЖЬ') return { k: 'num', v: 0 };
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
        return { k: 'call', name: t.text, args };
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

export function createEvaluator(grid: GridAccess): Evaluator {
  const cache = new Map<string, Scalar>();
  const visiting = new Set<string>();

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
      let val: Scalar;
      try {
        val = first(evalNode(parse(raw.slice(1)), 0));
      } catch {
        val = ERR.value;
      } finally {
        visiting.delete(key);
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

  function rangeValues(n: Extract<Node, { k: 'range' }>): Scalar[] {
    const out: Scalar[] = [];
    for (let r = n.r1; r <= n.r2; r++)
      for (let c = n.c1; c <= n.c2; c++) out.push(cellValue(r, c));
    return out;
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
      case 'ref': return cellValue(n.r, n.c);
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
        const exact = n.args[3] === undefined ? true : !toBool(evalNode(n.args[3], depth + 1));
        const pred = makeCriteria(first(a0));
        const { r1, c1, r2, c2 } = rangeNode;

        if (name === 'VLOOKUP') {
          for (let r = r1; r <= r2; r++) {
            if (!pred(cellValue(r, c1))) continue;
            const col = c1 + idx - 1;
            return col > c2 ? ERR.ref : cellValue(r, col);
          }
        } else {
          for (let c = c1; c <= c2; c++) {
            if (!pred(cellValue(r1, c))) continue;
            const row = r1 + idx - 1;
            return row > r2 ? ERR.ref : cellValue(row, c);
          }
        }
        void exact;
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
          const { r1, c1, r2, c2 } = rangeNode;
          // Одномерный диапазон адресуется одним индексом
          if (r1 === r2 && a2 === undefined) return cellValue(r1, c1 + rowN - 1);
          if (c1 === c2 && a2 === undefined) return cellValue(r1 + rowN - 1, c1);
          const r = r1 + rowN - 1, c = c1 + colN - 1;
          return (r > r2 || c > c2) ? ERR.ref : cellValue(r, c);
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

  return { evaluate, evalToString, cellValue };
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
];
