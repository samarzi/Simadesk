/**
 * Формулы расчёта цен на маркетплейсах.
 *
 * Каждый магазин (store_id) может иметь свою формулу — математическое выражение,
 * где `cost_price` — переменная (себестоимость товара).
 *
 * Примеры:
 *   cost_price * 2.2 + 252
 *   (cost_price * 2.4 + 214) * 0.99
 *   cost_price * 1.87 + 191
 *
 * Работает только когда у товара заполнена себестоимость в customColumnsDb.
 *
 * Безопасное вычисление: parser использует только числа, + - * / ( ) и переменную cost_price.
 * НЕ используется eval().
 */

export interface StoreFormula {
  store_id: string;
  formula: string;          // математическое выражение
  enabled: boolean;
  updated_at: string;
}

const KEY = 'price_formulas_v1';

function load(): StoreFormula[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function save(items: StoreFormula[]): void {
  localStorage.setItem(KEY, JSON.stringify(items));
}

export const priceFormulasDb = {
  getAll: (): StoreFormula[] => load(),

  getForStore: (storeId: string): StoreFormula | null =>
    load().find(f => f.store_id === storeId) ?? null,

  set: (storeId: string, formula: string, enabled = true): void => {
    const list = load();
    const idx = list.findIndex(f => f.store_id === storeId);
    const now = new Date().toISOString();
    if (idx >= 0) list[idx] = { store_id: storeId, formula, enabled, updated_at: now };
    else list.push({ store_id: storeId, formula, enabled, updated_at: now });
    save(list);
  },

  remove: (storeId: string): void => {
    save(load().filter(f => f.store_id !== storeId));
  },
};

// ── Безопасный парсер математических выражений ────────────────────────────────

/**
 * Tokenize + Shunting-yard → RPN → eval.
 * Принимает: числа, + - * / ( ), переменная cost_price.
 * Никаких функций кроме базовой математики. Никакого eval.
 */
type Token = { type: 'num' | 'op' | 'paren' | 'var'; value: string };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.,]/.test(c)) {
      let num = '';
      while (i < expr.length && /[0-9.,]/.test(expr[i])) {
        num += expr[i] === ',' ? '.' : expr[i];
        i++;
      }
      tokens.push({ type: 'num', value: num });
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      // Унарный минус/плюс в начале или после оператора/скобки
      const prev = tokens[tokens.length - 1];
      const isUnary = !prev || prev.type === 'op' || (prev.type === 'paren' && prev.value === '(');
      if ((c === '-' || c === '+') && isUnary) {
        tokens.push({ type: 'num', value: '0' });
      }
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ type: 'paren', value: c });
      i++;
      continue;
    }
    // переменная cost_price (или любой идентификатор → ошибка)
    if (/[a-zA-Z_]/.test(c)) {
      let ident = '';
      while (i < expr.length && /[a-zA-Z_0-9]/.test(expr[i])) {
        ident += expr[i];
        i++;
      }
      if (ident.toLowerCase() === 'cost_price' || ident.toLowerCase() === 'cost' || ident === 'c') {
        tokens.push({ type: 'var', value: 'cost_price' });
      } else {
        throw new Error(`Неизвестная переменная: ${ident}. Поддерживается только cost_price`);
      }
      continue;
    }
    throw new Error(`Неизвестный символ: ${c}`);
  }
  return tokens;
}

function precedence(op: string): number {
  if (op === '+' || op === '-') return 1;
  if (op === '*' || op === '/') return 2;
  return 0;
}

function toRPN(tokens: Token[]): Token[] {
  const out: Token[] = [];
  const stack: Token[] = [];
  for (const t of tokens) {
    if (t.type === 'num' || t.type === 'var') {
      out.push(t);
    } else if (t.type === 'op') {
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.type === 'op' && precedence(top.value) >= precedence(t.value)) {
          out.push(stack.pop()!);
        } else break;
      }
      stack.push(t);
    } else if (t.value === '(') {
      stack.push(t);
    } else if (t.value === ')') {
      while (stack.length > 0 && stack[stack.length - 1].value !== '(') {
        out.push(stack.pop()!);
      }
      if (stack.length === 0) throw new Error('Несбалансированные скобки');
      stack.pop();
    }
  }
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (top.value === '(' || top.value === ')') throw new Error('Несбалансированные скобки');
    out.push(top);
  }
  return out;
}

function evalRPN(rpn: Token[], variables: Record<string, number>): number {
  const stack: number[] = [];
  for (const t of rpn) {
    if (t.type === 'num') {
      stack.push(parseFloat(t.value));
    } else if (t.type === 'var') {
      const v = variables[t.value];
      if (v == null) throw new Error(`Переменная ${t.value} не задана`);
      stack.push(v);
    } else if (t.type === 'op') {
      if (stack.length < 2) throw new Error('Ошибка формулы');
      const b = stack.pop()!;
      const a = stack.pop()!;
      switch (t.value) {
        case '+': stack.push(a + b); break;
        case '-': stack.push(a - b); break;
        case '*': stack.push(a * b); break;
        case '/':
          if (b === 0) throw new Error('Деление на ноль');
          stack.push(a / b);
          break;
      }
    }
  }
  if (stack.length !== 1) throw new Error('Ошибка формулы');
  return stack[0];
}

/**
 * Безопасно вычислить формулу с подстановкой переменных.
 * Возвращает результат или null если формула невалидна.
 */
export function evaluateFormula(formula: string, costPrice: number): { ok: true; value: number } | { ok: false; error: string } {
  try {
    if (!formula?.trim()) return { ok: false, error: 'Пустая формула' };
    // Себестоимость должна быть заполнена и > 0 — иначе формула не применяется
    if (!isFinite(costPrice) || costPrice <= 0) {
      return { ok: false, error: 'Заполни себестоимость' };
    }
    const tokens = tokenize(formula);
    const rpn = toRPN(tokens);
    const result = evalRPN(rpn, { cost_price: costPrice });
    if (!isFinite(result)) return { ok: false, error: 'Результат не число' };
    return { ok: true, value: result };
  } catch (e: unknown) {
    return { ok: false, error: (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? String(e) };
  }
}

/** Проверка синтаксиса без подстановки реальной цены (для UI-валидации). */
export function validateFormula(formula: string): { ok: true } | { ok: false; error: string } {
  return evaluateFormula(formula, 100); // тестируем на cost=100
}
