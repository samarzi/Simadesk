import { describe, it, expect } from 'vitest';
import { normalizeMpDate } from '@/utils/mpDate';

describe('normalizeMpDate', () => {
  it('разбирает формат Яндекса DD-MM-YYYY HH:mm:ss как московское время', () => {
    // 15 августа 2026, 12:30 МСК = 09:30 UTC
    expect(normalizeMpDate('15-08-2026 12:30:00')).toBe('2026-08-15T09:30:00.000Z');
  });

  it('разбирает дату Яндекса без времени', () => {
    expect(normalizeMpDate('15-08-2026')).toBe('2026-08-14T21:00:00.000Z');
  });

  it('даёт ключ дня, совпадающий с сеткой графика', () => {
    // Именно из-за этого заказы Яндекса пропадали из графика и тепловой карты
    expect(normalizeMpDate('15-08-2026 12:30:00').slice(0, 10)).toBe('2026-08-15');
  });

  it('не трогает ISO от Ozon и WB', () => {
    expect(normalizeMpDate('2026-08-15T09:30:00.000Z')).toBe('2026-08-15T09:30:00.000Z');
  });

  it('не пересобирает дату без часового пояса — иначе она уезжает на сутки', () => {
    // `new Date('2026-08-15 12:30:45')` разбирается как локальное время,
    // и в отрицательных зонах срез первых 10 символов дал бы 14 августа.
    expect(normalizeMpDate('2026-08-15 12:30:45')).toBe('2026-08-15 12:30:45');
    expect(normalizeMpDate('2026-08-15 12:30:45').slice(0, 10)).toBe('2026-08-15');
  });

  it('сортировка строк остаётся хронологической', () => {
    const a = normalizeMpDate('02-09-2026 10:00:00');
    const b = normalizeMpDate('15-08-2026 10:00:00');
    expect(a.localeCompare(b)).toBeGreaterThan(0);
  });

  it('пустое и мусорное значение дают пустую строку', () => {
    expect(normalizeMpDate('')).toBe('');
    expect(normalizeMpDate(null)).toBe('');
    expect(normalizeMpDate('не дата')).toBe('');
  });
});
