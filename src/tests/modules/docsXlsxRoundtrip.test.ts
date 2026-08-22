/**
 * Round-trip оформления и типов через реальный .xlsx:
 * модель → exportExcelXlsx → zip → SheetJS → xlCellFromSheetJS.
 *
 * Это регрессия на потерю дизайна при экспорте и на превращение чисел
 * в текст при импорте — обе проблемы были у пользователя.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as XLSX from 'xlsx';
import { DocsModule } from '@/modules/DocsModule';
import { formatCellValue } from '@/utils/numFormat';

const HDR = 'background-color:#4472C4;color:#FFFFFF;font-weight:bold;text-align:center';

const ec = {
  sheets: [{
    name: 'Отчёт',
    data: [
      [{ v: 'Товар', s: HDR }, { v: 'Цена', s: HDR }, { v: 'Кол-во', s: HDR },
       { v: 'Сумма', s: HDR }, { v: 'Дата', s: HDR }],
      [{ v: 'Кофе' },
       { v: '1234.5', t: 'n' as const, nf: '#,##0.00\\ "₽"' },
       { v: '3', t: 'n' as const },
       { v: '=B2*C2', nf: '#,##0.00\\ "₽"' },
       { v: '45000', t: 'n' as const, nf: 'dd.mm.yyyy' }],
      [{ v: 'Чай', s: 'font-style:italic;border-bottom:1px solid #FF0000' },
       { v: '99.9', t: 'n' as const, nf: '#,##0.00\\ "₽"' },
       { v: '10', t: 'n' as const },
       { v: '=B3*C3', nf: '#,##0.00\\ "₽"' },
       { v: '45100', t: 'n' as const, nf: 'dd.mm.yyyy' }],
      [{ v: 'Скидка', s: 'font-weight:bold;font-style:italic;text-decoration:underline' },
       { v: '-0.15', t: 'n' as const, nf: '0.00%' },
       { v: '' }, { v: '' }, { v: '' }],
    ],
    colWidths: [140, 90, 70, 100, 100],
    rowHeights: [28, null, null, null],
    merges: [{ r1: 0, c1: 0, r2: 0, c2: 0 }],
  }],
};

let ws: XLSX.WorkSheet;
let M: any;

// Разобранный styles.xml и карта «адрес ячейки → индекс стиля» из sheet1.xml
let fonts: string[] = [];
let fills: string[] = [];
let borders: string[] = [];
let numFmtCodes: string[] = [];
let cellStyleIdx = new Map<string, number>();

interface Xf { fontId: number; fillId: number; borderId: number; numFmtId: number; raw: string }
let xfs: Xf[] = [];
const xfOf = (addr: string): Xf => xfs[cellStyleIdx.get(addr) ?? 0];

/** Вытащить повторяющиеся блоки одного уровня, например каждый <font>…</font>. */
function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>|<${tag}(?:\\s[^>]*)?/>`, 'g');
  return xml.match(re) ?? [];
}

beforeAll(async () => {
  M = Object.create(DocsModule.prototype);
  let blob: Blob | null = null;
  M.download = (_n: string, b: Blob) => { blob = b; };

  await M.exportExcelXlsx({ title: 't', type: 'excel', id: 'x', content: '', updated_at: 0 }, ec);
  expect(blob).toBeTruthy();

  const buf = Buffer.from(await blob!.arrayBuffer());
  const wb = XLSX.read(buf, {
    type: 'buffer', cellStyles: true, bookFiles: true,
    cellNF: true, cellFormula: true, cellDates: false,
  });
  ws = wb.Sheets[wb.SheetNames[0]];
  expect(wb.SheetNames[0]).toBe('Отчёт');

  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const stylesXml = await zip.file('xl/styles.xml')!.async('string');
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');

  fonts = blocks(stylesXml.match(/<fonts[\s\S]*?<\/fonts>/)![0], 'font');
  fills = blocks(stylesXml.match(/<fills[\s\S]*?<\/fills>/)![0], 'fill');
  borders = blocks(stylesXml.match(/<borders[\s\S]*?<\/borders>/)![0], 'border');
  numFmtCodes = [...stylesXml.matchAll(/<numFmt numFmtId="\d+" formatCode="([^"]*)"\/>/g)]
    .map(m => m[1].replace(/&quot;/g, '"'));

  xfs = blocks(stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/)![0], 'xf').map(raw => ({
    fontId: +(raw.match(/fontId="(\d+)"/)?.[1] ?? 0),
    fillId: +(raw.match(/fillId="(\d+)"/)?.[1] ?? 0),
    borderId: +(raw.match(/borderId="(\d+)"/)?.[1] ?? 0),
    numFmtId: +(raw.match(/numFmtId="(\d+)"/)?.[1] ?? 0),
    raw,
  }));

  cellStyleIdx = new Map();
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+\d+)"[^>]*?\bs="(\d+)"/g)) {
    cellStyleIdx.set(m[1], +m[2]);
  }
});

describe('типы значений переживают экспорт', () => {
  it('число остаётся числом, а не текстом', () => {
    expect(ws['B2'].t).toBe('n');
    expect(ws['B2'].v).toBe(1234.5);
  });

  it('числовой формат сохраняется', () => {
    expect(ws['B2'].z).toBe('#,##0.00\\ "₽"');
    // SheetJS форматирует по en-US; здесь важно лишь то, что формат вообще
    // применился к числу, а не к строке. Русский вид проверяет numFormat.test.
    expect(ws['B2'].w).toBe('1,234.50 ₽');
  });

  it('формула сохраняется вместе с посчитанным значением', () => {
    expect(ws['D2'].f).toBe('B2*C2');
    expect(ws['D2'].v).toBe(3703.5);
  });

  it('дата уезжает серийным числом с датным форматом', () => {
    expect(ws['E2'].v).toBe(45000);
    expect(ws['E2'].z).toBe('dd.mm.yyyy');
  });

  it('процент сохраняет знак и формат', () => {
    expect(ws['B4'].v).toBe(-0.15);
    expect(ws['B4'].z).toBe('0.00%');
  });

  it('текст остаётся текстом', () => {
    expect(ws['A1'].t).toBe('s');
    expect(ws['A1'].v).toBe('Товар');
  });
});

describe('оформление переживает экспорт', () => {
  // SheetJS CE не отдаёт индекс стиля ячейки на чтение (cell.s — это объект
  // только с заливкой), поэтому сверяем сгенерированный styles.xml напрямую.
  it('заливка, цвет и жирность шапки', () => {
    const xf = xfOf('A1');
    expect(fills[xf.fillId]).toContain('FF4472C4');
    expect(fonts[xf.fontId]).toContain('<b/>');
    expect(fonts[xf.fontId]).toContain('FFFFFFFF');
    expect(xf.raw).toContain('horizontal="center"');
  });

  it('жирный + курсив + подчёркнутый не вытесняют друг друга', () => {
    const f = fonts[xfOf('A4').fontId];
    expect(f).toContain('<b/>');
    expect(f).toContain('<i/>');
    expect(f).toContain('<u/>');
  });

  it('границы ячейки сохраняются', () => {
    const xf = xfOf('A3');
    expect(fonts[xf.fontId]).toContain('<i/>');
    expect(borders[xf.borderId]).toMatch(/<bottom style="thin"><color rgb="FFFF0000"\/><\/bottom>/);
  });

  it('ширины колонок и высоты строк переживают круг без дрейфа', () => {
    expect(Math.round((ws['!cols']?.[0] as any)?.width * 7)).toBe(140);
    expect(Math.round((ws['!rows']?.[0] as any)?.hpt * 4 / 3)).toBe(28);
  });

  it('числовой формат попадает в numFmts и привязан к ячейке', () => {
    expect(numFmtCodes).toContain('#,##0.00\\ "₽"');
    expect(numFmtCodes).toContain('dd.mm.yyyy');
    expect(numFmtCodes).toContain('0.00%');
    expect(xfOf('B2').numFmtId).toBeGreaterThanOrEqual(164);
  });
});

describe('обратный импорт восстанавливает модель', () => {
  it('число, тип и формат возвращаются как были', () => {
    const c = M.xlCellFromSheetJS(ws['B2']);
    expect(c.v).toBe('1234.5');
    expect(c.t).toBe('n');
    expect(c.nf).toBe('#,##0.00\\ "₽"');
    expect(formatCellValue(c.v, c.t, c.nf)).toBe('1 234,50 ₽');
  });

  it('формула возвращается формулой, а не замороженным числом', () => {
    expect(M.xlCellFromSheetJS(ws['D2']).v).toBe('=B2*C2');
  });

  it('дата снова показывается датой', () => {
    const c = M.xlCellFromSheetJS(ws['E2']);
    expect(formatCellValue(c.v, c.t, c.nf)).toBe('15.03.2023');
  });
});
