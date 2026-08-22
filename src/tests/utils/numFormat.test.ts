import { describe, it, expect } from 'vitest';
import {
  formatCellValue, parseUserNumber, isDateFormat,
  dateToSerial, serialToDate,
} from '@/utils/numFormat';

describe('formatCellValue — числа', () => {
  it.each([
    ['1234.5', '#,##0.00', '1 234,50'],
    ['1234.5', '#,##0', '1 235'],
    ['1234.5', '#,##0.00\\ "₽"', '1 234,50 ₽'],
    ['0.1567', '0.00%', '15,67%'],
    ['0.1567', '0%', '16%'],
    ['-42.5', '#,##0.00', '-42,50'],
    ['0.5', '0.0%', '50,0%'],
    ['1000000', '#,##0,, "млн"', '1 млн'],
  ])('%s @ %s → %s', (raw, fmt, want) => {
    expect(formatCellValue(raw, 'n', fmt)).toBe(want);
  });

  it('General и пустой формат оставляют значение машинным', () => {
    expect(formatCellValue('1234.5', 'n', 'General')).toBe('1234.5');
    expect(formatCellValue('1234.5', 'n', undefined)).toBe('1234.5');
  });

  it('секции разделяют положительное / отрицательное / ноль', () => {
    const fmt = '#,##0.00;(#,##0.00);"—"';
    expect(formatCellValue('5', 'n', fmt)).toBe('5,00');
    expect(formatCellValue('-5', 'n', fmt)).toBe('(5,00)');
    expect(formatCellValue('0', 'n', fmt)).toBe('—');
  });

  it('текст в числовом формате остаётся текстом', () => {
    expect(formatCellValue('abc', 's', '#,##0.00')).toBe('abc');
  });

  it('пустое значение остаётся пустым', () => {
    expect(formatCellValue('', 'n', '#,##0.00')).toBe('');
  });
});

describe('formatCellValue — даты', () => {
  it('серийный номер разворачивается в дату', () => {
    expect(formatCellValue('45000', 'n', 'dd.mm.yyyy')).toBe('15.03.2023');
    expect(formatCellValue('45000', 'n', 'd mmmm yyyy')).toBe('15 марта 2023');
  });

  it('mm — это минуты рядом с часами и месяц в остальных случаях', () => {
    expect(formatCellValue('45000.5', 'n', 'dd.mm.yyyy hh:mm')).toBe('15.03.2023 12:00');
  });
});

describe('parseUserNumber', () => {
  it.each([
    ['1 234,50 ₽', 1234.5],
    ['15,67%', 0.1567],
    ['-42,5', -42.5],
    ['1234.5', 1234.5],
  ])('%s → %s', (input, want) => {
    expect(parseUserNumber(input)).toBeCloseTo(want as number, 10);
  });

  it('нечисловое возвращает null', () => {
    expect(parseUserNumber('abc')).toBeNull();
    expect(parseUserNumber('')).toBeNull();
  });
});

describe('isDateFormat', () => {
  it('отличает датные маски от числовых', () => {
    expect(isDateFormat('dd.mm.yyyy')).toBe(true);
    expect(isDateFormat('yyyy-mm-dd hh:mm')).toBe(true);
    expect(isDateFormat('#,##0.00')).toBe(false);
    expect(isDateFormat('0.00%')).toBe(false);
  });

  it('не путается о буквы внутри литералов', () => {
    expect(isDateFormat('0" days"')).toBe(false);
  });
});

describe('серийные номера Excel', () => {
  it('туда-обратно без потерь', () => {
    const d = new Date(Date.UTC(2023, 2, 15));
    expect(dateToSerial(d)).toBe(45000);
    expect(serialToDate(45000).toISOString()).toBe(d.toISOString());
  });
});
