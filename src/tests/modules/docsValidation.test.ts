import { describe, it, expect } from 'vitest';
import { compactValidations, ValidationIndex } from '@/modules/docs/validation';

const rule = { type: 'list', formulae: ['"Да,Нет"'], allowBlank: true };
const other = { type: 'list', formulae: ['"A,B"'] };

describe('проверка данных (выпадающие списки)', () => {
  it('30 000 одинаковых правил по ячейкам сводятся в один диапазон', () => {
    const dv: Record<string, any> = {};
    for (let r = 4; r < 30004; r++) dv[`A${r}`] = rule;
    const out = compactValidations(dv);
    expect(Object.keys(out)).toEqual(['A4:A30003']);
    expect(out['A4:A30003']).toEqual(rule);
    expect(JSON.stringify(out).length).toBeLessThan(200);
  });

  it('разные правила и разрывы сохраняются', () => {
    const dv: Record<string, any> = {};
    for (let r = 2; r <= 50; r++) dv[`B${r}`] = rule;
    for (let r = 60; r <= 70; r++) dv[`B${r}`] = rule;
    for (let r = 2; r <= 40; r++) dv[`C${r}`] = other;
    dv['D1:D5'] = rule;
    const out = compactValidations(dv);
    expect(out['B2:B50 B60:B70 D1:D5']).toEqual(rule);
    expect(out['C2:C40']).toEqual(other);
  });

  it('небольшие наборы не трогаются', () => {
    const dv = { A1: rule, B2: other };
    expect(compactValidations(dv)).toBe(dv);
  });

  it('индекс находит правило по ячейке так же, как прямой перебор', () => {
    const idx = new ValidationIndex({ 'B2:B50 B60:B70 D1:D5': rule, 'C2:C40': other, 'E1:E100000': rule, "'Лист 2'!F3": other });
    expect(idx.at(1, 1)).toBe(rule);      // B2
    expect(idx.at(55, 1)).toBeNull();     // B56 — разрыв
    expect(idx.at(69, 1)).toBe(rule);     // B70
    expect(idx.at(10, 2)).toBe(other);    // C11
    expect(idx.at(99999, 4)).toBe(rule);  // E100000
    expect(idx.at(2, 5)).toBe(other);     // F3 с именем листа
    expect(idx.at(0, 0)).toBeNull();
  });

  it('поиск по индексу быстрый даже на тысячах правил', () => {
    const dv: Record<string, any> = {};
    for (let r = 1; r <= 30000; r++) dv[`A${r}`] = { type: 'list', formulae: [`"v${r % 3}"`] };
    const idx = new ValidationIndex(dv);
    const t = performance.now();
    for (let r = 0; r < 200; r++) for (let c = 0; c < 30; c++) idx.at(r, c);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

import ExcelJS from 'exceljs';
import { readXlsx, writeXlsxBytes } from '@/modules/docs/xlsxIO';

describe('проверка данных: Excel → редактор → Excel', () => {
  it('список на 30 000 ячеек хранится одним диапазоном и работает на всех ячейках после выгрузки', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Остатки');
    ws.getCell('A1').value = 'Склад';
    ws.getCell('B1').value = 'Остаток';
    for (let r = 4; r <= 30003; r++) ws.dataValidations.add(`A${r}`, { type: 'list', allowBlank: true, formulae: ['"Да,Нет"'] });
    const src = await wb.xlsx.writeBuffer();

    const ec = await readXlsx(src as ArrayBuffer);
    const dv = (ec.sheets[0].xl as any).dv;
    expect(Object.keys(dv)).toEqual(['A4:A30003']);

    const helpers = { formulaResult: () => '', rangeValues: () => [] };
    const bytes = await writeXlsxBytes(ec, helpers);
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const ws2 = back.worksheets[0];
    for (const addr of ['A4', 'A15000', 'A30003']) {
      expect(ws2.getCell(addr).dataValidation?.type).toBe('list');
      expect(ws2.getCell(addr).dataValidation?.formulae?.[0]).toBe('"Да,Нет"');
    }
    expect(ws2.getCell('A3').dataValidation).toBeFalsy();
    expect(ws2.getCell('B4').dataValidation).toBeFalsy();
  }, 60_000);
});

describe('проверка данных: несколько диапазонов одного правила', () => {
  it('выгружаются в Excel с сохранением разрывов', async () => {
    const ec = { sheets: [{ name: 'Лист1', data: [[{ v: 'x' }]], xl: { dv: { 'B2:B50 B60:B70': { type: 'list', allowBlank: true, formulae: ['"A,B"'] } } } }] } as any;
    const bytes = await writeXlsxBytes(ec, { formulaResult: () => '', rangeValues: () => [] });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const ws = back.worksheets[0];
    expect(ws.getCell('B2').dataValidation?.type).toBe('list');
    expect(ws.getCell('B65').dataValidation?.type).toBe('list');
    expect(ws.getCell('B55').dataValidation).toBeFalsy();
  });
});
