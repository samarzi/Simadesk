import { describe, it, expect } from 'vitest';
import { mskCalendarRange, mskDayKey } from '@/utils/mpDate';

// Среда, 14 октября 2026, 01:30 по Москве (ещё 13-е по UTC)
const now = new Date('2026-10-13T22:30:00.000Z');
const days = (r: { start: Date; end: Date }) => [mskDayKey(r.start.toISOString()), mskDayKey(r.end.toISOString())];

describe('календарные периоды по Москве', () => {
  it('вчера', () => expect(days(mskCalendarRange('yesterday', now))).toEqual(['2026-10-13', '2026-10-13']));
  it('эта неделя — с понедельника', () => expect(days(mskCalendarRange('week', now))).toEqual(['2026-10-12', '2026-10-14']));
  it('прошлая неделя — пн–вс', () => expect(days(mskCalendarRange('prev_week', now))).toEqual(['2026-10-05', '2026-10-11']));
  it('этот месяц', () => expect(days(mskCalendarRange('month', now))).toEqual(['2026-10-01', '2026-10-14']));
  it('прошлый месяц', () => expect(days(mskCalendarRange('prev_month', now))).toEqual(['2026-09-01', '2026-09-30']));
  it('прошлый месяц в январе — декабрь прошлого года', () => {
    expect(days(mskCalendarRange('prev_month', new Date('2026-01-10T10:00:00Z')))).toEqual(['2025-12-01', '2025-12-31']);
  });
  it('границы — московские сутки', () => {
    const r = mskCalendarRange('yesterday', now);
    expect(r.start.toISOString()).toBe('2026-10-12T21:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-13T20:59:59.999Z');
  });
});
