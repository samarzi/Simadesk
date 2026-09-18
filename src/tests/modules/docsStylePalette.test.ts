/**
 * Палитра стилей листа.
 *
 * Раньше полная CSS-строка дублировалась в каждую ячейку: таблица на 1000 строк
 * с оформлением весила 4 МБ при квоте localStorage в 5 МБ на весь домен.
 * Документ переставал помещаться в кеш — и терялся вместе с цветами.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DocsModule } from '@/modules/DocsModule';

const CSS = 'background-color:#ffff00;font-weight:bold;font-size:15px;font-family:"Calibri",sans-serif;color:#ff0000';
let M: any;
beforeEach(() => { M = Object.create(DocsModule.prototype); });

const grid = (rows: number, cols = 26, css: string | null = CSS) =>
  Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ v: 'Значение', t: 'n' as const, nf: '#,##0.00', ...(css ? { s: css } : {}) })));

describe('цвета переживают сохранение и загрузку', () => {
  it('заливка и цвет шрифта возвращаются в точности', () => {
    const ec = { sheets: [{ name: 'Лист1', data: grid(3) }] };
    const back = M.parseExcelContent(M.serializeExcel(ec));
    expect(back.sheets[0].data[0][0].s).toBe(CSS);
    expect(back.sheets[0].data[2][25].s).toBe(CSS);
  });

  it('разные стили не путаются между собой', () => {
    const red = 'background-color:#ff0000';
    const blue = 'background-color:#0000ff';
    const ec = { sheets: [{ name: 'S', data: [[
      { v: 'a', s: red }, { v: 'b', s: blue }, { v: 'c' }, { v: 'd', s: red },
    ]] }] };
    const back = M.parseExcelContent(M.serializeExcel(ec));
    const row = back.sheets[0].data[0];
    expect(row[0].s).toBe(red);
    expect(row[1].s).toBe(blue);
    expect(row[2].s).toBeUndefined();
    expect(row[3].s).toBe(red);
  });

  it('палитра содержит каждый стиль ровно один раз', () => {
    const ec = { sheets: [{ name: 'S', data: grid(50) }] };
    const raw = JSON.parse(M.serializeExcel(ec));
    expect(raw.sheets[0].styles).toHaveLength(1);
    expect(raw.sheets[0].styles[0]).toBe(CSS);
    expect(raw.sheets[0].data[0][0].si).toBe(0);
    expect(raw.sheets[0].data[0][0].s).toBeUndefined();
  });

  it('тип, формат, ширины и объединения не теряются', () => {
    const ec = { sheets: [{
      name: 'S', data: grid(2, 3),
      colWidths: [70, null, 140], rowHeights: [20, null],
      merges: [{ r1: 0, c1: 0, r2: 0, c2: 1 }],
    }] };
    const back = M.parseExcelContent(M.serializeExcel(ec));
    const sh = back.sheets[0];
    expect(sh.data[0][0].t).toBe('n');
    expect(sh.data[0][0].nf).toBe('#,##0.00');
    expect(sh.colWidths).toEqual([70, null, 140]);
    expect(sh.rowHeights).toEqual([20, null]);
    expect(sh.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 1 }]);
  });
});

describe('старый формат продолжает читаться', () => {
  it('стиль строкой прямо в ячейке', () => {
    const old = JSON.stringify({ sheets: [{ name: 'S', data: [[{ v: '1', s: CSS, t: 'n' }]] }] });
    const back = M.parseExcelContent(old);
    expect(back.sheets[0].data[0][0].s).toBe(CSS);
    expect(back.sheets[0].data[0][0].t).toBe('n');
  });

  it('битый номер стиля не роняет разбор', () => {
    const raw = JSON.stringify({ sheets: [{ name: 'S', styles: [CSS], data: [[{ v: '1', si: 99 }, { v: '2', si: 0 }]] }] });
    const row = M.parseExcelContent(raw).sheets[0].data[0];
    expect(row[0].s).toBeUndefined();
    expect(row[1].s).toBe(CSS);
  });
});

describe('размер документа', () => {
  it('таблица на 1000 строк снова помещается в квоту браузера', () => {
    const ec = { sheets: [{ name: 'Лист1', data: grid(1000) }] };
    const fat = JSON.stringify(ec).length;              // как было: стиль в каждой ячейке
    const lean = M.serializeExcel(ec).length;           // как стало: палитра
    expect(fat).toBeGreaterThan(3_500_000);             // ~4 МБ при квоте браузера в 5 МБ
    expect(lean).toBeLessThan(2_000_000);
    expect(lean * 3).toBeLessThan(fat);                 // выигрыш минимум втрое
  });
});
