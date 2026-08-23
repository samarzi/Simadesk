/**
 * Аналитические действия ассистента над таблицей.
 *
 * Раньше Сима видела только первые 30 строк из describe() и считала «на глаз»,
 * из-за чего на больших таблицах отвечала неверно или молчала. Эти действия
 * дают ей точный ответ по всем строкам — тесты фиксируют именно это.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DocsModule } from '@/modules/DocsModule';

type Cell = { v: string; t?: 'n'; nf?: string };
const n = (v: number, nf?: string): Cell => ({ v: String(v), t: 'n', ...(nf ? { nf } : {}) });
const s = (v: string): Cell => ({ v });

//      A: Артикул   B: Товар   C: Цена  D: Кол-во  E: Город
const ROWS: Cell[][] = [
  [s('Артикул'), s('Товар'), s('Цена'), s('Кол-во'), s('Город')],
  [s('A-1'), s('Кофе'),  n(100, '#,##0.00\\ "₽"'), n(3),  s('Мадрид')],
  [s('A-2'), s('Чай'),   n(50,  '#,##0.00\\ "₽"'), n(10), s('Барселона')],
  [s('A-3'), s('Какао'), n(200, '#,##0.00\\ "₽"'), n(2),  s('Мадрид')],
  [s('A-1'), s('Сок'),   n(80,  '#,##0.00\\ "₽"'), n(5),  s('Мадрид')],
  [s('A-4'), s('Вода'),  s(''),                    n(7),  s('Барселона')],
  [s(''),    s('Хлеб'),  n(-5,  '#,##0.00\\ "₽"'), n(1),  s('Мадрид')],
];

let M: any;

beforeEach(() => {
  M = Object.create(DocsModule.prototype);
  const doc = {
    id: 'd1', type: 'excel', title: 'Прайс', updated_at: 0,
    content: JSON.stringify({ sheets: [{ name: 'Лист1', data: ROWS }] }),
  };
  M.docs = [doc];
  M.activeId = 'd1';
  M.activeSheetIdx = 0;
  M.fxRows = null;
  M.fxEval = null;
  M.render = () => {};
  M.updateContent = (_id: string, c: string) => { doc.content = c; };
});

describe('excel_schema — дешёвая карта листа', () => {
  it('распознаёт типы колонок и заполненность', () => {
    const out: string = M.aiExcelSchema();
    expect(out).toContain('6 строк данных × 5 колонок');
    expect(out).toMatch(/C «Цена» — число/);
    expect(out).toMatch(/E «Город» — категория/);
    // Цена пуста у «Вода» — 5 из 6
    expect(out).toMatch(/«Цена».*заполнено 5\/6/);
  });
});

describe('excel_aggregate — точный счёт по всем строкам', () => {
  it('сумма по колонке', () => {
    expect(M.aiExcelAggregate({ op: 'sum', column: 'Цена' })).toContain('= 425');
  });

  it('среднее пропускает пустые ячейки', () => {
    // (100+50+200+80-5)/5 = 85
    expect(M.aiExcelAggregate({ op: 'avg', column: 'Цена' })).toContain('= 85');
  });

  it('count считает строки данных', () => {
    expect(M.aiExcelAggregate({ op: 'count' })).toContain('= 6');
  });

  it('countdistinct по артикулам', () => {
    // A-1, A-2, A-3, A-4 и одна пустая — уникальных непустых 4
    expect(M.aiExcelAggregate({ op: 'countdistinct', column: 'Артикул' })).toContain('= 4');
  });

  it('группировка по категории', () => {
    const out: string = M.aiExcelAggregate({ op: 'sum', column: 'Кол-во', groupBy: 'Город' });
    expect(out).toMatch(/Мадрид: 11/);      // 3 + 2 + 5 + 1
    expect(out).toMatch(/Барселона: 17/);   // 10 + 7
  });

  it('отбор по условию до подсчёта', () => {
    const out: string = M.aiExcelAggregate({ op: 'sum', column: 'Цена', where: { 'Город': 'Мадрид' } });
    expect(out).toContain('= 375');         // 100 + 200 + 80 - 5
  });

  it('числовой критерий в отборе', () => {
    const out: string = M.aiExcelAggregate({ op: 'count', where: { 'Цена': '>75' } });
    expect(out).toContain('= 3');           // 100, 200, 80
  });

  it('понятная ошибка, если колонки нет', () => {
    expect(() => M.aiExcelAggregate({ op: 'sum', column: 'Маржа' }))
      .toThrow(/Маржа.*не найдена/);
  });

  it('понятная ошибка на неизвестной операции', () => {
    expect(() => M.aiExcelAggregate({ op: 'медиана', column: 'Цена' }))
      .toThrow(/неизвестна/);
  });
});

describe('excel_query — выборка строк', () => {
  it('фильтрует по точному значению', () => {
    const out: string = M.aiExcelQuery({ where: { 'Город': 'Барселона' }, columns: ['Товар'] });
    expect(out).toContain('найдено 2 строк');
    expect(out).toContain('Чай');
    expect(out).toContain('Вода');
    expect(out).not.toContain('Кофе');
  });

  it('фильтрует по сравнению', () => {
    const out: string = M.aiExcelQuery({ where: { 'Цена': '>=100' }, columns: ['Товар'] });
    expect(out).toContain('найдено 2 строк');
  });

  it('маска в критерии', () => {
    const out: string = M.aiExcelQuery({ where: { 'Артикул': 'A-1*' }, columns: ['Товар'] });
    expect(out).toContain('найдено 2 строк');
  });

  it('сортировка по числовой колонке', () => {
    const out: string = M.aiExcelQuery({ columns: ['Товар'], sortBy: 'Цена', desc: true });
    const order = ['Какао', 'Кофе', 'Сок', 'Чай'].map(t => out.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('показывает отформатированные значения, а не сырые', () => {
    const out: string = M.aiExcelQuery({ where: { 'Товар': 'Кофе' }, columns: ['Цена'] });
    expect(out).toContain('₽');
  });

  it('ограничивает выдачу и сообщает общее число', () => {
    const out: string = M.aiExcelQuery({ limit: 2 });
    expect(out).toContain('найдено 6 строк, показаны первые 2');
  });
});

describe('excel_find — поиск с адресами', () => {
  it('находит вхождения и даёт адрес', () => {
    const out: string = M.aiExcelFind({ query: 'Мадрид' });
    expect(out).toContain('встречается 4 раз');
    expect(out).toMatch(/E2 \(стр\.2/);
  });

  it('точное совпадение отсекает частичные', () => {
    expect(M.aiExcelFind({ query: 'A-1', exact: true })).toContain('встречается 2 раз');
    expect(M.aiExcelFind({ query: 'A-1', exact: false })).toContain('встречается 2 раз');
  });

  it('поиск в конкретной колонке', () => {
    const out: string = M.aiExcelFind({ query: 'а', columns: ['Товар'] });
    expect(out).not.toContain('Мадрид');
  });
});

describe('excel_validate — проверки качества', () => {
  it('находит дубли', () => {
    const out: string = M.aiExcelValidate({ duplicates: ['Артикул'] });
    expect(out).toMatch(/Дубли.*1 значений повторяются/);
    expect(out).toContain('«a-1»');
  });

  it('находит пустые в обязательной колонке', () => {
    const out: string = M.aiExcelValidate({ required: ['Артикул'] });
    expect(out).toMatch(/Пустые.*1 строк/);
  });

  it('находит неположительные числа', () => {
    const out: string = M.aiExcelValidate({ positive: ['Цена'] });
    expect(out).toMatch(/Неположительные.*1 строк/);
  });

  it('чистая колонка отмечается как чистая', () => {
    expect(M.aiExcelValidate({ duplicates: ['Товар'] })).toMatch(/Дубли.*не найдено/);
  });

  it('без указания проверок подсказывает, что доступно', () => {
    expect(M.aiExcelValidate({})).toContain('duplicates');
  });
});

describe('excel_read_range', () => {
  it('читает прямоугольник с адресами', () => {
    const out: string = M.aiExcelReadRange({ range: 'B2:C3' });
    expect(out).toContain('B2=Кофе');
    expect(out).toContain('C3=50,00 ₽');
  });

  it('отвергает мусорный диапазон', () => {
    expect(() => M.aiExcelReadRange({ range: 'абв' })).toThrow(/A1:D20/);
  });
});

describe('формулы участвуют в аналитике', () => {
  beforeEach(() => {
    const withFormula = ROWS.map(r => [...r]);
    withFormula[1] = [...ROWS[1]];
    withFormula[1][2] = { v: '=50*2', t: 'n' } as Cell;   // та же цена 100, но формулой
    M.docs[0].content = JSON.stringify({ sheets: [{ name: 'Лист1', data: withFormula }] });
    M.fxRows = null; M.fxEval = null;
  });

  it('сумма учитывает вычисленное значение формулы', () => {
    expect(M.aiExcelAggregate({ op: 'sum', column: 'Цена' })).toContain('= 425');
  });
});

describe('предпросмотр разрушающих действий', () => {
  it('удаление документа называет его и предупреждает', () => {
    const p: string = M.aiPreviewDestructive('docs_delete', { docIds: ['d1'] });
    expect(p).toContain('«Прайс»');
    expect(p).toContain('необратимо');
  });

  it('удаление строк считает, сколько именно попадёт', () => {
    const p: string = M.aiPreviewDestructive('excel_delete_rows', { column: 'Город', value_filter: 'Мадрид' });
    expect(p).toContain('Будет удалено строк: 4');
  });

  it('массовая замена считает вхождения', () => {
    const p: string = M.aiPreviewDestructive('multi_replace', { docIds: 'all', find: 'Мадрид', replaceWith: 'Madrid' });
    expect(p).toContain('4 вхождений');
  });

  it('для неразрушающего действия предпросмотра нет', () => {
    expect(M.aiPreviewDestructive('excel_query', {})).toBeNull();
  });
});

describe('тип и формат переживают сохранение', () => {
  // Регрессия: normalizeCellGrid пропускал только v и s, поэтому число
  // и его денежный формат стирались при первой же перезагрузке документа.
  it('parseExcelContent сохраняет t и nf', () => {
    const raw = JSON.stringify({
      sheets: [{ name: 'S', data: [[{ v: '1234.5', t: 'n', nf: '#,##0.00\\ "₽"', s: 'font-weight:bold' }]] }],
    });
    const cell = M.parseExcelContent(raw).sheets[0].data[0][0];
    expect(cell.v).toBe('1234.5');
    expect(cell.t).toBe('n');
    expect(cell.nf).toBe('#,##0.00\\ "₽"');
    expect(cell.s).toBe('font-weight:bold');
  });

  it('мусорный тип отбрасывается, а не протекает в модель', () => {
    const raw = JSON.stringify({ sheets: [{ name: 'S', data: [[{ v: '1', t: 'хм', nf: 42 }]] }] });
    const cell = M.parseExcelContent(raw).sheets[0].data[0][0];
    expect(cell.t).toBeUndefined();
    expect(cell.nf).toBeUndefined();
  });
});
