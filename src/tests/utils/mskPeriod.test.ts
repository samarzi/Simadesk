import { describe, it, expect } from 'vitest';
import { mskDayKey, mskHourAndDay, mskRange } from '@/utils/mpDate';

describe('московские сутки', () => {
  it('заказ в 01:30 МСК относится к текущему дню, а не ко вчерашнему', () => {
    // 2026-09-17T22:30:00Z === 2026-09-18 01:30 по Москве
    expect(mskDayKey('2026-09-17T22:30:00.000Z')).toBe('2026-09-18');
  });

  it('заказ в 23:00 МСК не уезжает в следующий день', () => {
    // 2026-09-18T20:00:00Z === 2026-09-18 23:00 МСК
    expect(mskDayKey('2026-09-18T20:00:00.000Z')).toBe('2026-09-18');
  });

  it('полночь по Москве — это начало суток', () => {
    expect(mskDayKey('2026-09-17T21:00:00.000Z')).toBe('2026-09-18');
  });

  it('час берётся московский, а не UTC', () => {
    // 09:00 UTC === 12:00 МСК
    expect(mskHourAndDay('2026-09-18T09:00:00.000Z')?.hour).toBe(12);
  });

  it('день недели тоже московский на стыке суток', () => {
    // 2026-09-17T22:00Z = пятница 18 сентября 01:00 МСК (17-е — четверг)
    const at = mskHourAndDay('2026-09-17T22:00:00.000Z');
    expect(at?.hour).toBe(1);
    expect(at?.day).toBe(new Date('2026-09-18T12:00:00Z').getUTCDay());
  });
});

describe('период «Сегодня»', () => {
  const now = new Date('2026-09-18T09:00:00.000Z'); // 12:00 МСК

  it('охватывает ровно одни московские сутки', () => {
    const { start, end } = mskRange(1, now);
    expect(start.toISOString()).toBe('2026-09-17T21:00:00.000Z'); // 00:00 МСК 18-го
    expect(end.toISOString()).toBe('2026-09-18T20:59:59.999Z');   // 23:59 МСК 18-го
  });

  it('ловит заказ, сделанный в 01:00 по Москве — раньше он терялся', () => {
    const { start, end } = mskRange(1, now);
    const order = new Date('2026-09-17T22:00:00.000Z'); // 01:00 МСК 18-го
    expect(order >= start && order <= end).toBe(true);
  });

  it('не захватывает вчерашний вечер', () => {
    const { start } = mskRange(1, now);
    const yesterdayEvening = new Date('2026-09-17T20:00:00.000Z'); // 23:00 МСК 17-го
    expect(yesterdayEvening < start).toBe(true);
  });

  it('30 дней включают текущие сутки и 29 предыдущих', () => {
    const { start, end } = mskRange(30, now);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    expect(days).toBe(30);
    expect(mskDayKey(end.toISOString())).toBe('2026-09-18');
    expect(mskDayKey(start.toISOString())).toBe('2026-08-20');
  });

  it('границы периода сами попадают в свой московский день', () => {
    const { start, end } = mskRange(7, now);
    expect(mskDayKey(start.toISOString())).toBe('2026-09-12');
    expect(mskDayKey(end.toISOString())).toBe('2026-09-18');
  });
});
