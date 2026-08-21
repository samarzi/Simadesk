import { describe, it, expect } from 'vitest';
import { isWithinRange } from '@/services/orderSyncService';

const start = new Date('2026-07-20T00:00:00.000Z');
const end   = new Date('2026-08-19T23:59:59.999Z');

describe('isWithinRange', () => {
  it('отсекает заказы из закэшированной части месяца вне периода', () => {
    // Кэш хранится помесячно: при попадании в кэш возвращался весь июль,
    // включая 1–19 число, которых в запрошенных «30 днях» нет.
    expect(isWithinRange('2026-07-05T10:00:00.000Z', start, end)).toBe(false);
    expect(isWithinRange('2026-07-25T10:00:00.000Z', start, end)).toBe(true);
  });

  it('отсекает заказы позже конца периода', () => {
    // WB грузился от начала без верхней границы — до «сегодня»
    expect(isWithinRange('2026-08-25T10:00:00.000Z', start, end)).toBe(false);
  });

  it('понимает формат дат Яндекса', () => {
    expect(isWithinRange('05-07-2026 10:00:00', start, end)).toBe(false);
    expect(isWithinRange('25-07-2026 10:00:00', start, end)).toBe(true);
  });

  it('включает границы периода', () => {
    expect(isWithinRange(start.toISOString(), start, end)).toBe(true);
    expect(isWithinRange(end.toISOString(), start, end)).toBe(true);
  });

  it('заказ без даты не выбрасывается', () => {
    expect(isWithinRange('', start, end)).toBe(true);
    expect(isWithinRange(null, start, end)).toBe(true);
    expect(isWithinRange('мусор', start, end)).toBe(true);
  });
});
