import { describe, it, expect } from 'vitest';
import {
  createEvaluator, toExcelFormula, offsetFormula, shiftFormulaRefs, renameSheetInFormula,
  type GridAccess,
} from '@/utils/formula';

/** Книга из нескольких листов: имя → строки. */
function book(sheets: Record<string, string[][]>) {
  const grids = new Map<string, GridAccess>();
  const mk = (name: string): GridAccess => ({
    raw: (r, c) => sheets[name][r]?.[c] ?? '',
    rowCount: () => sheets[name].length,
    sheet: (n) => {
      const key = Object.keys(sheets).find(k => k.toLowerCase() === n.toLowerCase());
      return key ? grids.get(key)! : null;
    },
  });
  for (const n of Object.keys(sheets)) grids.set(n, mk(n));
  return (name: string) => createEvaluator(grids.get(name)!);
}

const B = book({
  'Продажи': [['Товар', 'Сумма'], ['Кофе', '100'], ['Чай', '50'], ['Какао', '25']],
  'Итоги': [['Всего', "=SUM('Продажи'!B2:B4)"], ['Макс', '=МАКС(Продажи!B:B)'], ['Цикл', '=Итоги!B3']],
});

describe('ссылки на другие листы', () => {
  it('лист в кавычках и без', () => {
    expect(B('Итоги').evalToString("=SUM('Продажи'!B2:B4)")).toBe('175');
    expect(B('Итоги').evalToString('=Продажи!B2*2')).toBe('200');
  });
  it('формула на другом листе ссылается на третий', () => {
    expect(B('Итоги').evalToString('=B1')).toBe('175');
  });
  it('колонка целиком', () => {
    expect(B('Итоги').evalToString('=B2')).toBe('100');
    expect(B('Продажи').evalToString('=COUNTA(A:A)')).toBe('4');
  });
  it('несуществующий лист — #REF!', () => {
    expect(B('Итоги').evalToString('=Нет!A1')).toBe('#REF!');
  });
  it('цикл через лист ловится', () => {
    expect(B('Итоги').evalToString('=B3')).toBe('#ЦИКЛ!');
  });
});

describe('русские имена функций', () => {
  it.each([
    ['=СУММ(Продажи!B2:B4)', '175'],
    ['=ЕСЛИ(Продажи!B2>60;"много";"мало")', 'много'],
    ['=СЧЁТЕСЛИ(Продажи!B2:B4;">40")', '2'],
    ['=ОКРУГЛ(10/3;2)', '3.33'],
    ['=ВПР("Чай";Продажи!A2:B4;2;ЛОЖЬ)', '50'],
  ])('%s → %s', (f, want) => expect(B('Итоги').evalToString(f)).toBe(want));
});

describe('новые функции', () => {
  it.each([
    ['=LARGE(Продажи!B2:B4,2)', '50'],
    ['=RANK(50,Продажи!B2:B4)', '2'],
    ['=SUBTOTAL(9,Продажи!B2:B4)', '175'],
    ['=ROWS(Продажи!A1:B4)', '4'],
    ['=VLOOKUP(30,Продажи!B4:B4,1,TRUE)', '25'],
  ])('%s → %s', (f, want) => expect(B('Итоги').evalToString(f)).toBe(want));
});

describe('перезапись формул', () => {
  it('в xlsx — английские имена и запятые', () => {
    expect(toExcelFormula('=СУММ(A1:A5;\'Лист 2\'!B1)')).toBe("SUM(A1:A5,'Лист 2'!B1)");
    expect(toExcelFormula('=ЕСЛИ(A1>0;"да; нет";ЛОЖЬ)')).toBe('IF(A1>0,"да; нет",FALSE)');
  });
  it('автозаполнение сдвигает относительные ссылки', () => {
    expect(offsetFormula('=A1+$B$1+B$2+$C3', 1, 1)).toBe('=B2+$B$1+C$2+$C4');
    expect(offsetFormula('=SUM(A1:A3)', 2, 0)).toBe('=SUM(A3:A5)');
    expect(offsetFormula('=A1', -1, 0)).toBe('=#REF!');
  });
  it('вставка строки сдвигает ссылки ниже точки вставки', () => {
    const op = { axis: 'row' as const, at: 2, count: 1 };
    expect(shiftFormulaRefs('=SUM(B2:B10)+B1', op, true, () => false)).toBe('=SUM(B2:B11)+B1');
    expect(shiftFormulaRefs('=SUM(B3:B10)', op, true, () => false)).toBe('=SUM(B4:B11)');
    expect(shiftFormulaRefs('=Лист2!B5', op, true, n => n === 'Лист2')).toBe('=Лист2!B6');
    expect(shiftFormulaRefs('=Лист2!B5', op, true, () => false)).toBe('=Лист2!B5');
  });
  it('удаление строки стягивает диапазон и ломает одиночную ссылку', () => {
    const op = { axis: 'row' as const, at: 2, count: -1 };   // удалить строку 3
    expect(shiftFormulaRefs('=SUM(B2:B10)', op, true, () => false)).toBe('=SUM(B2:B9)');
    expect(shiftFormulaRefs('=B3', op, true, () => false)).toBe('=#REF!');
    expect(shiftFormulaRefs('=B4', op, true, () => false)).toBe('=B3');
  });
  it('переименование листа', () => {
    expect(renameSheetInFormula("='Лист 1'!A1+Лист2!B2", 'Лист 1', 'Итоги')).toBe('=Итоги!A1+Лист2!B2');
  });
});
