/**
 * Нормализация дат маркетплейсов в ISO 8601 (UTC).
 *
 * Ozon и WB отдают ISO. Яндекс Маркет — «DD-MM-YYYY HH:mm:ss» по московскому
 * времени и без указания зоны: `new Date()` такую строку не разбирает и молча
 * возвращает Invalid Date.
 *
 * Раньше эта строка попадала в аналитику как есть, и последствия были неочевидными:
 * `date.slice(0, 10)` давал «15-08-2026», что никогда не совпадало с ключами дней
 * вида «2026-08-15» — заказы Яндекса просто исчезали из графика и тепловой карты,
 * а сортировка списка заказов шла по числу месяца.
 */

/** Московское смещение (Яндекс отдаёт время без зоны именно в нём). */
const MSK_OFFSET_MS = 3 * 3600 * 1000;

const YM_DATE_RE = /^(\d{2})[.\-/](\d{2})[.\-/](\d{4})(?:[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

/** Уже начинается с YYYY-MM-DD — трогать не нужно. */
const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Приводит дату маркетплейса к ISO-строке в UTC.
 * Возвращает '' для пустого или неразбираемого значения — вызывающий код
 * уже умеет обрабатывать заказ без даты.
 */
export function normalizeMpDate(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';

  // Значение уже в виде YYYY-MM-DD… — возвращаем как есть.
  // Пересобирать его через `new Date()` опасно: строку без указания зоны
  // («2026-08-15 12:30:45») движок разбирает как локальное время и сдвигает дату.
  // Для аналитики важны сортируемость и срез первых 10 символов — они уже верны.
  if (ISO_PREFIX_RE.test(s)) return s;

  // Формат Яндекса: DD-MM-YYYY [HH:mm[:ss]] по Москве
  const m = YM_DATE_RE.exec(s);
  if (m) {
    const [, dd, mm, yyyy, h = '0', mi = '0', sec = '0'] = m;
    const utcMs = Date.UTC(+yyyy, +mm - 1, +dd, +h, +mi, +sec) - MSK_OFFSET_MS;
    const d = new Date(utcMs);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * Календарный день по Москве для ISO-инстанта — «YYYY-MM-DD».
 *
 * Все три площадки отчитываются по московскому времени, и продавец мыслит
 * московскими сутками. Раньше день брался срезом первых 10 символов ISO-строки,
 * то есть по UTC: заказ, сделанный в 01:30 по Москве, попадал во вчерашний день
 * и во вчерашний столбец графика. На длинном периоде это была краевая
 * погрешность, но для периода «Сегодня» — потеря первых трёх часов суток.
 */
export function mskDayKey(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  // Не разобралось — отдаём срез, он хотя бы сортируется.
  if (isNaN(t)) return String(iso).slice(0, 10);
  return new Date(t + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Час (0-23) и день недели (0=вс) по Москве — для тепловой карты активности. */
export function mskHourAndDay(iso: string | null | undefined): { hour: number; day: number } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  const shifted = new Date(t + MSK_OFFSET_MS);
  return { hour: shifted.getUTCHours(), day: shifted.getUTCDay() };
}

/**
 * Границы периода в московских сутках, выраженные UTC-инстантами.
 * `days = 1` — сегодня с 00:00 МСК; `days = 30` — последние 30 суток включая текущие.
 */
export function mskRange(days: number, now: Date = new Date()): { start: Date; end: Date } {
  // «Сейчас» в московской системе координат.
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const endMskMidnight = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
  const startMskMidnight = endMskMidnight - (Math.max(1, days) - 1) * 86_400_000;
  return {
    start: new Date(startMskMidnight - MSK_OFFSET_MS),
    end:   new Date(endMskMidnight + 86_400_000 - 1 - MSK_OFFSET_MS),
  };
}

/** Московская полночь заданного дня «YYYY-MM-DD» как UTC-инстант. */
export function mskDayStart(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1) - MSK_OFFSET_MS);
}

export type CalendarPreset = 'yesterday' | 'week' | 'prev_week' | 'month' | 'prev_month';

/**
 * Календарные периоды по Москве: вчера, текущая/прошлая неделя (пн–вс),
 * текущий/прошлый месяц. Менеджеры отчитываются именно так, а не
 * «последними 30 днями». Текущие неделя и месяц заканчиваются сегодня.
 */
export function mskCalendarRange(preset: CalendarPreset, now: Date = new Date()): { start: Date; end: Date } {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const y = msk.getUTCFullYear(), m = msk.getUTCMonth(), d = msk.getUTCDate();
  const day = (yy: number, mm: number, dd: number) => Date.UTC(yy, mm, dd);
  const today = day(y, m, d);
  const DAY = 86_400_000;
  let from: number, to: number; // московские полуночи, to — включительно
  switch (preset) {
    case 'yesterday': from = to = today - DAY; break;
    case 'week': {
      const dow = (msk.getUTCDay() + 6) % 7; // 0 = понедельник
      from = today - dow * DAY; to = today; break;
    }
    case 'prev_week': {
      const dow = (msk.getUTCDay() + 6) % 7;
      to = today - (dow + 1) * DAY; from = to - 6 * DAY; break;
    }
    case 'month': from = day(y, m, 1); to = today; break;
    case 'prev_month': from = day(y, m - 1, 1); to = day(y, m, 1) - DAY; break;
  }
  return { start: new Date(from - MSK_OFFSET_MS), end: new Date(to + DAY - 1 - MSK_OFFSET_MS) };
}
