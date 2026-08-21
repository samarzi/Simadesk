import { describe, it, expect, vi, afterEach } from 'vitest';
import { isMonthSettled, SETTLED_DAYS } from '@/services/analyticsOrderCache';

afterEach(() => vi.useRealTimers());

function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe('isMonthSettled', () => {
  const august = new Date(Date.UTC(2026, 7, 15)); // любой день августа

  it('месяц не закрыт сразу после его окончания', () => {
    // Раньше август становился неизменяемым 1 сентября, и заказы конца августа,
    // ещё ехавшие к покупателю, замораживались в кэше как «в пути» навсегда.
    at('2026-09-01T10:00:00.000Z');
    expect(isMonthSettled(august)).toBe(false);
  });

  it('месяц не закрыт за день до истечения отсрочки', () => {
    at('2026-09-14T10:00:00.000Z');
    expect(isMonthSettled(august)).toBe(false);
  });

  it('месяц закрывается через SETTLED_DAYS после конца', () => {
    at('2026-09-15T00:00:01.000Z');
    expect(isMonthSettled(august)).toBe(true);
  });

  it('текущий месяц никогда не закрыт', () => {
    at('2026-08-20T10:00:00.000Z');
    expect(isMonthSettled(august)).toBe(false);
  });

  it('давно прошедший месяц закрыт', () => {
    at('2026-12-01T00:00:00.000Z');
    expect(isMonthSettled(august)).toBe(true);
  });

  it('отсрочка покрывает типичный цикл доставки', () => {
    expect(SETTLED_DAYS).toBeGreaterThanOrEqual(14);
  });
});
