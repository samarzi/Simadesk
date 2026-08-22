import { describe, it, expect } from 'vitest';
import { createEvaluator, type GridAccess } from '@/utils/formula';

/** Лист из массива строк; пустая строка = пустая ячейка. */
function sheet(rows: string[][]) {
  const grid: GridAccess = {
    raw: (r, c) => rows[r]?.[c] ?? '',
  };
  return createEvaluator(grid);
}

//        A          B        C          D
const DATA = [
  ['Товар',    'Цена',  'Кол-во',  'Город'],   // 1
  ['Кофе',     '100',   '3',       'Мадрид'],  // 2
  ['Чай',      '50',    '10',      'Барселона'],// 3
  ['Какао',    '200',   '2',       'Мадрид'],  // 4
  ['Сок',      '',      '5',       'Мадрид'],  // 5
];

const ev = () => sheet(DATA);

describe('арифметика и приоритеты', () => {
  it.each([
    ['=2+3*4', '14'],
    ['=(2+3)*4', '20'],
    ['=2^3^2', '512'],        // правоассоциативный
    // Excel применяет унарный минус раньше степени: -2^2 = (-2)^2 = 4
    ['=-2^2', '4'],
    ['=10/4', '2.5'],
    ['=10/0', '#DIV/0!'],
    ['=50%', '0.5'],
    ['=200*10%', '20'],
    ['=1+2=3', 'ИСТИНА'],
  ])('%s → %s', (f, want) => {
    expect(ev().evalToString(f)).toBe(want);
  });
});

describe('ссылки и диапазоны', () => {
  it('одиночная ссылка', () => {
    expect(ev().evalToString('=B2')).toBe('100');
  });
  it('абсолютная ссылка равна относительной', () => {
    expect(ev().evalToString('=$B$2')).toBe('100');
  });
  it('диапазон в агрегате', () => {
    expect(ev().evalToString('=SUM(B2:B5)')).toBe('350');
    expect(ev().evalToString('=COUNT(B2:B5)')).toBe('3');
    expect(ev().evalToString('=COUNTA(A2:A5)')).toBe('4');
    expect(ev().evalToString('=COUNTBLANK(B2:B5)')).toBe('1');
  });
  it('двумерный диапазон', () => {
    expect(ev().evalToString('=SUM(B2:C5)')).toBe('370');
  });
});

describe('вложенные вызовы — то, что раньше ломалось', () => {
  it.each([
    ['=SUM(ABS(-5),B2)', '105'],
    ['=IF(B2>50,SUM(C2:C5),0)', '20'],
    ['=ROUND(AVERAGE(B2:B4),1)', '116.7'],
    ['=MAX(MIN(B2,B3),C2)', '50'],
    ['=SUM(B2:B4)/COUNT(B2:B4)', '116.6666666667'],
    ['=IF(AND(B2>50,C2>1),"да","нет")', 'да'],
    ['=IFERROR(1/0,"ошибка")', 'ошибка'],
    ['=IF(A2="Кофе",UPPER(A2),LOWER(A2))', 'КОФЕ'],
  ])('%s → %s', (f, want) => {
    expect(ev().evalToString(f)).toBe(want);
  });
});

describe('строковое сравнение в IF — раньше не работало', () => {
  it('сравнивает текст, а не приводит его к нулю', () => {
    expect(ev().evalToString('=IF(D2="Мадрид",1,0)')).toBe('1');
    expect(ev().evalToString('=IF(D3="Мадрид",1,0)')).toBe('0');
  });
  it('сравнение без учёта регистра, как в Excel', () => {
    expect(ev().evalToString('=IF(D2="мадрид",1,0)')).toBe('1');
  });
});

describe('условные агрегаты', () => {
  it('COUNTIF по тексту и по условию', () => {
    expect(ev().evalToString('=COUNTIF(D2:D5,"Мадрид")')).toBe('3');
    expect(ev().evalToString('=COUNTIF(B2:B5,">60")')).toBe('2');
    expect(ev().evalToString('=COUNTIF(A2:A5,"К*")')).toBe('2');
  });
  it('SUMIF со отдельным диапазоном суммирования', () => {
    expect(ev().evalToString('=SUMIF(D2:D5,"Мадрид",C2:C5)')).toBe('10');
  });
  it('SUMIFS по двум условиям', () => {
    // Мадрид с ценой > 50 — строки 2 и 4, их количества 3 и 2
    expect(ev().evalToString('=SUMIFS(C2:C5,D2:D5,"Мадрид",B2:B5,">50")')).toBe('5');
  });
  it('COUNTIFS', () => {
    expect(ev().evalToString('=COUNTIFS(D2:D5,"Мадрид",C2:C5,">=3")')).toBe('2');
  });
  it('AVERAGEIF', () => {
    expect(ev().evalToString('=AVERAGEIF(D2:D5,"Мадрид",B2:B5)')).toBe('150');
  });
});

describe('поиск', () => {
  it('VLOOKUP находит строку и возвращает колонку', () => {
    expect(ev().evalToString('=VLOOKUP("Чай",A2:D5,2)')).toBe('50');
    expect(ev().evalToString('=VLOOKUP("Чай",A2:D5,4)')).toBe('Барселона');
  });
  it('VLOOKUP без совпадения даёт #N/A', () => {
    expect(ev().evalToString('=VLOOKUP("Пиво",A2:D5,2)')).toBe('#N/A');
  });
  it('INDEX + MATCH', () => {
    expect(ev().evalToString('=INDEX(B2:B5,MATCH("Какао",A2:A5,0))')).toBe('200');
  });
  it('XLOOKUP c запасным значением', () => {
    expect(ev().evalToString('=XLOOKUP("Пиво",A2:A5,B2:B5,"нет")')).toBe('нет');
  });
});

describe('текстовые функции', () => {
  it.each([
    ['=CONCATENATE(A2," — ",D2)', 'Кофе — Мадрид'],
    ['=A2&" из "&D2', 'Кофе из Мадрид'],
    ['=LEN(A2)', '4'],
    ['=LEFT(A2,2)', 'Ко'],
    ['=RIGHT(A2,2)', 'фе'],
    ['=MID(D3,1,5)', 'Барсе'],
    ['=UPPER(A2)', 'КОФЕ'],
    ['=PROPER("иван петров")', 'Иван Петров'],
    ['=SUBSTITUTE(D2,"Мадрид","Мадрид!")', 'Мадрид!'],
    ['=TEXTJOIN(", ",TRUE,A2:A5)', 'Кофе, Чай, Какао, Сок'],
    ['=TRIM("  два   слова  ")', 'два слова'],
    ['=FIND("фе",A2)', '3'],
  ])('%s → %s', (f, want) => {
    expect(ev().evalToString(f)).toBe(want);
  });
});

describe('даты', () => {
  it('DATE и разбор компонентов', () => {
    expect(ev().evalToString('=DATE(2023,3,15)')).toBe('45000');
    expect(ev().evalToString('=YEAR(45000)')).toBe('2023');
    expect(ev().evalToString('=MONTH(45000)')).toBe('3');
    expect(ev().evalToString('=DAY(45000)')).toBe('15');
  });
  it('разница дат', () => {
    expect(ev().evalToString('=DAYS(DATE(2023,3,20),DATE(2023,3,15))')).toBe('5');
    expect(ev().evalToString('=DATEDIF(DATE(2022,1,10),DATE(2023,3,15),"M")')).toBe('14');
  });
  it('EOMONTH даёт конец месяца', () => {
    expect(ev().evalToString('=DAY(EOMONTH(DATE(2024,2,10),0))')).toBe('29');
  });
});

describe('формулы, ссылающиеся на формулы', () => {
  const chain = () => sheet([
    ['5'],
    ['=A1*2'],
    ['=A2+1'],
    ['=SUM(A1:A3)'],
  ]);
  it('цепочка вычисляется вглубь', () => {
    expect(chain().evalToString('=A3')).toBe('11');
    expect(chain().evalToString('=A4')).toBe('26');
  });
});

describe('циклические ссылки не вешают вычисление', () => {
  it('прямой цикл', () => {
    const e = sheet([['=A1']]);
    expect(e.evalToString('=A1')).toBe('#ЦИКЛ!');
  });
  it('взаимный цикл', () => {
    const e = sheet([['=B1', '=A1']]);
    expect(e.evalToString('=A1')).toBe('#ЦИКЛ!');
  });
});

describe('ошибки', () => {
  it('неизвестная функция', () => {
    expect(ev().evalToString('=НЕТТАКОЙ(1)')).toBe('#NAME?');
  });
  it('ошибка распространяется наружу', () => {
    expect(ev().evalToString('=SUM(1,1/0)')).toBe('#DIV/0!');
  });
  it('ISERROR ловит ошибку', () => {
    expect(ev().evalToString('=ISERROR(1/0)')).toBe('ИСТИНА');
  });
});

describe('пробелы и регистр не мешают', () => {
  it.each([
    ['=  SUM( B2 : B4 )  ', '350'],
    ['=sum(b2:b4)', '350'],
    ['=SuM(B2:B4)', '350'],
  ])('%s → %s', (f, want) => {
    expect(ev().evalToString(f)).toBe(want);
  });
});

describe('строки с кавычками', () => {
  it('экранированная кавычка внутри строки', () => {
    expect(ev().evalToString('="он сказал ""да"""')).toBe('он сказал "да"');
  });
  it('точка с запятой как разделитель аргументов', () => {
    expect(ev().evalToString('=SUM(1;2;3)')).toBe('6');
  });
});
