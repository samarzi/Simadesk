/**
 * «Открыл в SimaDesk → сохранил» не должно менять файл Excel.
 *
 * Пользователь жаловался: экспорт приходит «в другом дизайне», а пустые
 * строки и колонки пропадают. Тест собирает файл со всем, что встречается в
 * реальных отчётах, прогоняет через импорт и экспорт и сверяет результат
 * с исходником средствами ExcelJS — тем же, чем читает Excel.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readXlsx, writeXlsxBytes } from '@/modules/docs/xlsxIO';
import type { ExcelContent } from '@/modules/docs/model';
import { createEvaluator } from '@/utils/formula';

async function makeSource(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Отчёт', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 3, showGridLines: false }],
    properties: { tabColor: { argb: 'FF00B050' } } as any,
  });
  // Пустые строки 1–2 и колонка A — сверху и слева; данные начинаются с B3
  ws.getCell('B3').value = 'Товар';
  ws.getCell('C3').value = 'Сумма';
  for (const a of ['B3', 'C3']) {
    const c = ws.getCell(a);
    c.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };   // белый текст
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } };   // чёрная заливка
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'double', color: { argb: 'FFFF0000' } }, left: { style: 'dashDot', color: { argb: 'FF00FF00' } } };
  }
  ws.getCell('B4').value = 'Кофе';
  ws.getCell('B4').alignment = { indent: 2 };
  ws.getCell('C4').value = 1234.5;
  ws.getCell('C4').numFmt = '#,##0.00 "₽"';
  ws.getCell('C4').font = { italic: true, underline: 'double', color: { theme: 4, tint: -0.25 } as any };
  ws.getCell('B5').value = 'Чай';
  ws.getCell('C5').value = 99.9;
  ws.getCell('C5').fill = { type: 'pattern', pattern: 'solid', fgColor: { indexed: 13 } as any };
  ws.getCell('B6').value = 'Итого';
  ws.getCell('C6').value = { formula: 'SUM(C4:C5)', result: 1334.4 } as any;
  ws.getCell('D8').border = { top: { style: 'medium', color: { argb: 'FF0000FF' } } };   // пустая, но с рамкой
  ws.getCell('B7').value = { richText: [{ text: 'жир', font: { bold: true } }, { text: 'ный' }] } as any;
  ws.getCell('B9').value = new Date(Date.UTC(2026, 0, 15));
  ws.getCell('B9').numFmt = 'dd.mm.yyyy';
  ws.mergeCells('E3:F4');
  ws.getColumn(2).width = 24;
  ws.getColumn(5).hidden = true;
  ws.getRow(3).height = 30;
  ws.getRow(8).hidden = true;
  ws.autoFilter = 'B3:C6';
  ws.getCell('B4').note = 'Примечание';
  ws.getCell('B10').value = { text: 'сайт', hyperlink: 'https://simadesk.ru' } as any;
  const second = wb.addWorksheet('Пустой лист');
  second.getCell('A1').value = 'x';
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}

const helpers = (ec: ExcelContent) => ({
  formulaResult: (si: number, r: number, c: number) => {
    const sh = ec.sheets[si];
    return createEvaluator({ raw: (rr, cc) => sh.data[rr]?.[cc]?.v ?? '' }).evalToString(sh.data[r][c].v);
  },
  rangeValues: () => [],
});

let ec: ExcelContent;
let out: ExcelJS.Workbook;

beforeAll(async () => {
  ec = await readXlsx(await makeSource());
  const bytes = await writeXlsxBytes(ec, helpers(ec));
  out = new ExcelJS.Workbook();
  await out.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
});

describe('импорт: ничего не теряется', () => {
  it('пустые строки и колонка слева на месте — данные с B3, а не с A1', () => {
    const sh = ec.sheets[0];
    expect(sh.data[2][1].v).toBe('Товар');
    expect(sh.data[0].every(c => !c.v)).toBe(true);
    expect(sh.data[2][0].v).toBe('');
  });
  it('белый текст на чёрной заливке сохраняется', () => {
    const s = ec.sheets[0].data[2][1].s!;
    expect(s).toContain('color:#ffffff');
    expect(s).toContain('background-color:#000000');
  });
  it('числа остаются числами, даты — серийными номерами с форматом', () => {
    const c = ec.sheets[0].data[3][2];
    expect(c).toMatchObject({ v: '1234.5', t: 'n' });
    expect(ec.sheets[0].data[8][1]).toMatchObject({ t: 'n', nf: 'dd.mm.yyyy' });
  });
  it('формула, примечание, ссылка, форматированный текст', () => {
    const d = ec.sheets[0].data;
    expect(d[5][2].v).toBe('=SUM(C4:C5)');
    expect(d[3][1].note).toBe('Примечание');
    expect(d[9][1].link).toBe('https://simadesk.ru');
    expect(d[6][1].rt?.[0]).toMatchObject({ text: 'жир' });
  });
  it('шрифт книги, закрепление, скрытое, ширины, объединения', () => {
    const sh = ec.sheets[0];
    expect(ec.font).toEqual({ name: 'Calibri', size: 11 });
    expect(sh.freeze).toEqual({ rows: 3, cols: 1 });
    expect(sh.hiddenCols).toContain(4);
    expect(sh.hiddenRows).toContain(7);
    expect(sh.merges).toContainEqual({ r1: 2, c1: 4, r2: 3, c2: 5 });
    expect(sh.colWidths?.[1]).toBe(173);
    expect(sh.rowHeights?.[2]).toBe(40);
    expect(sh.showGrid).toBe(false);
    expect(sh.tabColor).toBe('#00b050');
    expect(sh.autoFilter).toBe('B3:C6');
  });
});

describe('экспорт: файл того же дизайна', () => {
  const ws = () => out.getWorksheet('Отчёт')!;
  it('оформление шапки совпадает с исходником', () => {
    const c = ws().getCell('B3');
    expect(c.font).toMatchObject({ name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } });
    expect((c.fill as any).fgColor.argb).toBe('FF000000');
    expect(c.alignment).toMatchObject({ horizontal: 'center', vertical: 'middle', wrapText: true });
    expect(c.border.bottom).toMatchObject({ style: 'double', color: { argb: 'FFFF0000' } });
    expect(c.border.left).toMatchObject({ style: 'dashDot' });
  });
  it('отступ, двойное подчёркивание, индексная заливка, числовой формат', () => {
    expect(ws().getCell('B4').alignment).toMatchObject({ indent: 2 });
    expect(ws().getCell('C4').font).toMatchObject({ italic: true, underline: 'double' });
    expect(ws().getCell('C4').numFmt).toBe('#,##0.00 "₽"');
    expect((ws().getCell('C5').fill as any).fgColor.argb).toBe('FFFFFF00');   // индекс 13 палитры Excel — жёлтый
    expect(ws().getCell('C4').value).toBe(1234.5);
  });
  it('пустая ячейка с рамкой не потерялась', () => {
    expect(ws().getCell('D8').border.top).toMatchObject({ style: 'medium' });
  });
  it('формула с кэшем результата, дата, ссылка', () => {
    expect(ws().getCell('C6').value).toMatchObject({ formula: 'SUM(C4:C5)', result: 1334.4 });
    expect(ws().getCell('B9').numFmt).toBe('dd.mm.yyyy');
    expect(ws().getCell('B10').value).toMatchObject({ hyperlink: 'https://simadesk.ru' });
  });
  it('структура листа', () => {
    expect(ws().views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 3, showGridLines: false });
    expect(ws().getColumn(5).hidden).toBe(true);
    expect(ws().getRow(8).hidden).toBe(true);
    expect(ws().getColumn(2).width).toBeCloseTo(24, 0);
    expect(ws().getRow(3).height).toBe(30);
    expect((ws().model as any).merges).toContain('E3:F4');
    expect(out.worksheets.map(w => w.name)).toEqual(['Отчёт', 'Пустой лист']);
  });
});

describe('диаграммы', () => {
  it('диаграмма уходит в файл и читается обратно', async () => {
    const book: ExcelContent = {
      sheets: [{
        name: 'Продажи',
        data: [[{ v: 'Месяц' }, { v: 'Выручка' }], [{ v: 'Янв' }, { v: '100', t: 'n' }], [{ v: 'Фев' }, { v: '150', t: 'n' }]],
        charts: [{ id: 'c1', kind: 'col', title: 'Выручка', series: [{ nameRef: 'B1', catRef: 'A2:A3', valRef: 'B2:B3' }], r: 1, c: 3, w: 400, h: 240 }],
      }],
    };
    const bytes = await writeXlsxBytes(book, { formulaResult: () => '', rangeValues: (ref) => ref === 'A2:A3' ? ['Янв', 'Фев'] : ref === 'B1' ? ['Выручка'] : ['100', '150'] });
    const zip = await JSZip.loadAsync(bytes);
    const chart = await zip.file('xl/charts/chart1.xml')!.async('string');
    expect(chart).toContain('<c:barDir val="col"/>');
    expect(chart).toContain('Продажи!$B$2:$B$3');
    const back = await readXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(back.sheets[0].charts?.[0]).toMatchObject({ kind: 'col', title: 'Выручка', r: 1, c: 3 });
    expect(back.sheets[0].charts?.[0].series[0].valRef).toBe('Продажи!$B$2:$B$3');
  });
});
