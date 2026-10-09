/**
 * Оформление ячеек: куда оно применяется и во что превращается строка стиля.
 *
 * Два бага из жизни, оба в одной команде «покрась эту ячейку»:
 *   1) красились ВСЕ ячейки листа — ассистент вызывал excel_style_range без
 *      аргумента range, а пустой range молча означал «весь лист»;
 *   2) редактор через какое-то время вставал намертво и браузер предлагал
 *      закрыть вкладку — стиль не заменялся, а дописывался в хвост, и строка
 *      в каждой ячейке росла с каждой правкой.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DocsModule } from '@/modules/DocsModule';

let M: any;
let doc: any;

const sheetOf = () => M.parseExcelContent(doc.content).sheets[0];

beforeEach(() => {
  M = Object.create(DocsModule.prototype);
  Object.assign(M, { dirty: new Set(), serverKnown: new Set(), recentSyncTimers: new Map(), memberNames: new Map(), xlSelMemo: {}, bookCache: null, wbEval: null, srvV2: false, pendingContent: new Set(), warnedNoPersist: new Set(), recent: [] });
  const data = Array.from({ length: 5 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => ({ v: `r${r}c${c}` })));
  doc = { id: 'd1', type: 'excel', title: 'T', content: JSON.stringify({ sheets: [{ name: 'Лист1', data }] }) };
  M.docs = [doc];
  M.activeId = 'd1';
  M.activeSheetIdx = 0;
  M.xlUndoStack = []; M.xlRedoStack = [];
  M.pushXlUndo = () => {};
  M.aiPersist = (d: any, ec: any) => { d.content = M.serializeExcel(ec); };
  M.docsResult = (_id: string, _before: string, msg: string) => ({ message: msg });
  M.xlLastSel = null;
});

describe('excel_style_range не трогает лишнего', () => {
  it('без range это ошибка, а не «весь лист»', () => {
    expect(() => M.aiStyleRange({ bg: '#ff0000' })).toThrow(/не указан диапазон/i);
    // лист не тронут
    expect(sheetOf().data.flat().every((c: any) => !c.s)).toBe(true);
  });

  it('одна ячейка — красится ровно одна', () => {
    M.aiStyleRange({ range: 'B2', bg: '#ff0000' });
    const d = sheetOf().data;
    expect(d[1][1].s).toContain('background-color:#ff0000');
    const painted = d.flat().filter((c: any) => c.s).length;
    expect(painted).toBe(1);
  });

  it('диапазон за краем листа обрезается, а не достраивает миллионы ячеек', () => {
    M.aiStyleRange({ range: 'A1:ZZ100000', bg: '#00ff00' });
    const d = sheetOf().data;
    expect(d).toHaveLength(5);
    expect(d[0]).toHaveLength(4);
  });

  it('диапазон целиком вне листа — понятная ошибка', () => {
    expect(() => M.aiStyleRange({ range: 'A50:D60', bg: '#00ff00' })).toThrow(/за пределами листа/i);
  });

  it('"all" по-прежнему красит весь лист', () => {
    M.aiStyleRange({ range: 'all', bg: '#0000ff' });
    expect(sheetOf().data.flat().every((c: any) => c.s?.includes('background-color:#0000ff'))).toBe(true);
  });
});

describe('excel_style_selection берёт только выделение', () => {
  it('красит выделенный прямоугольник и ничего больше', () => {
    M.xlLastSel = { r1: 1, c1: 1, r2: 2, c2: 2, docId: 'd1', sheetIdx: 0 };
    M.aiStyleSelection({ bg: '#ffff00' });
    const d = sheetOf().data;
    expect(d.flat().filter((c: any) => c.s).length).toBe(4);
    expect(d[1][1].s).toContain('#ffff00');
    expect(d[0][0].s).toBeUndefined();
  });

  it('без выделения — ошибка, а не покраска всего', () => {
    expect(() => M.aiStyleSelection({ bg: '#ffff00' })).toThrow(/выдели/i);
  });

  it('устаревшее выделение за краем листа обрезается', () => {
    M.xlLastSel = { r1: 0, c1: 0, r2: 9999, c2: 9999, docId: 'd1', sheetIdx: 0 };
    M.aiStyleSelection({ bg: '#ffff00' });
    expect(sheetOf().data).toHaveLength(5);
  });
});

describe('строка стиля не растёт от повторных правок', () => {
  it('десять смен заливки оставляют одно свойство background', () => {
    for (let i = 0; i < 10; i++) M.aiStyleRange({ range: 'A1', bg: `#ff00${i}${i}` });
    const s: string = sheetOf().data[0][0].s;
    expect(s.match(/background-color:/g)).toHaveLength(1);
    expect(s).toContain('background-color:#ff0099');
    expect(s.length).toBeLessThan(40);
  });

  it('документ не распухает: 50 правок всего листа почти не меняют размер', () => {
    M.aiStyleRange({ range: 'all', bg: '#ff0000' });
    const afterFirst = doc.content.length;
    for (let i = 0; i < 50; i++) M.aiStyleRange({ range: 'all', bg: '#00ff00' });
    // раньше рост был линейным по числу правок — здесь он должен отсутствовать
    expect(doc.content.length).toBeLessThan(afterFirst * 1.2);
  });

  it('разные свойства складываются, одноимённые заменяются', () => {
    M.aiStyleRange({ range: 'A1', bg: '#ff0000', bold: true });
    M.aiStyleRange({ range: 'A1', bg: '#0000ff' });
    const s: string = sheetOf().data[0][0].s;
    expect(s).toContain('font-weight:bold');
    expect(s).toContain('background-color:#0000ff');
    expect(s).not.toContain('#ff0000');
  });

  it('background-color из импорта xlsx перекрывается заливкой из тулбара', () => {
    expect(M.mergeCellCss('background-color:#ffff00;font-weight:bold', 'background:#ff0000;'))
      .toBe('font-weight:bold;background-color:#ff0000');
  });

  it('одинаково оформленные ячейки дают одинаковую строку — палитра их схлопывает', () => {
    M.aiStyleRange({ range: 'A1', bg: '#ff0000' });
    M.aiStyleRange({ range: 'A1', bg: '#00ff00' });
    M.aiStyleRange({ range: 'B1', bg: '#00ff00' });
    const raw = JSON.parse(doc.content);
    expect(raw.sheets[0].styles).toHaveLength(1);
  });
});
