/**
 * numFormat — практичное подмножество движка числовых форматов Excel.
 *
 * Покрывает форматы, которые реально встречаются в выгрузках и отчётах:
 * General, 0.00, #,##0, проценты, валюты с литералами, даты и время,
 * секции «положительное;отрицательное;ноль;текст».
 *
 * Не поддерживает: дроби (# ?/?), научную нотацию с E+, цветовые модификаторы
 * ([Red]), условия ([>100]) — такие форматы отдаются как обычное число.
 */

export type CellType = 'n' | 's' | 'd' | 'b';

/** Excel хранит даты как «дней с 1899-12-30» (включая баг високосного 1900). */
const EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;

export function serialToDate(serial: number): Date {
  return new Date(EPOCH + Math.round(serial * DAY_MS));
}

export function dateToSerial(d: Date): number {
  return (d.getTime() - EPOCH) / DAY_MS;
}

/** Формат описывает дату/время, а не число? */
export function isDateFormat(fmt: string): boolean {
  if (!fmt) return false;
  // Убираем литералы в кавычках и escape-последовательности, чтобы не ловить
  // букву «d» внутри текста вроде "days".
  const bare = fmt.replace(/"[^"]*"/g, '').replace(/\\./g, '');
  return /(^|[^\\])(yy|mmm|dd?|hh?|ss)/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

const MONTHS_RU = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const MONTHS_SHORT_RU = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const DAYS_RU = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
const DAYS_SHORT_RU = ['вс','пн','вт','ср','чт','пт','сб'];

/**
 * Разбить формат на секции по «;», не считая разделителем «;» внутри кавычек.
 */
function splitSections(fmt: string): string[] {
  const out: string[] = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '\\') { cur += ch + (fmt[i + 1] ?? ''); i++; continue; }
    if (ch === '"') { inQuote = !inQuote; cur += ch; continue; }
    if (ch === ';' && !inQuote) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Разложить секцию на числовое ядро и литералы вокруг него. */
interface NumSpec {
  prefix: string;
  suffix: string;
  intDigits: number;    // минимум цифр целой части (нули в маске)
  decDigits: number;    // цифр после запятой
  thousands: boolean;   // группировать разряды
  percent: boolean;
  scale: number;        // деление на 1000 за каждую запятую в конце маски
  hasDigits: boolean;   // в маске вообще есть место под цифры?
}

function parseNumericSection(sec: string): NumSpec {
  const spec: NumSpec = {
    prefix: '', suffix: '', intDigits: 1, decDigits: 0,
    thousands: false, percent: false, scale: 1, hasDigits: true,
  };

  // Вытащить ядро маски — непрерывный кусок из # 0 , . ? и пробелов между ними
  const coreMatch = sec.match(/[#0](?:[#0,.\s?]*[#0])?/);
  if (!coreMatch) {
    // Маска без цифр — чистый литерал, например секция нуля «"—"»
    spec.prefix = unescapeLiterals(sec);
    spec.intDigits = 0;
    spec.hasDigits = false;
    return spec;
  }

  const core = coreMatch[0];
  const at = coreMatch.index!;
  let tail = sec.slice(at + core.length);

  // Запятые сразу после ядра масштабируют результат на 1000 каждая
  // («#,##0,,» — миллионы). Ядро их не захватывает, т.к. кончается на цифре.
  const scaleCommas = tail.match(/^,+/);
  if (scaleCommas) {
    spec.scale = Math.pow(1000, scaleCommas[0].length);
    tail = tail.slice(scaleCommas[0].length);
  }

  spec.prefix = unescapeLiterals(sec.slice(0, at));
  spec.suffix = unescapeLiterals(tail);

  if (sec.includes('%')) spec.percent = true;

  const body = core;
  spec.thousands = body.includes(',');
  const clean = body.replace(/,/g, '');
  const dot = clean.indexOf('.');
  if (dot >= 0) {
    spec.intDigits = (clean.slice(0, dot).match(/0/g) ?? []).length;
    spec.decDigits = clean.slice(dot + 1).replace(/[^#0]/g, '').length;
  } else {
    spec.intDigits = (clean.match(/0/g) ?? []).length;
    spec.decDigits = 0;
  }
  return spec;
}

/** Снять кавычки и обратные слэши, оставив видимый текст литерала. */
function unescapeLiterals(s: string): string {
  return s
    .replace(/\[\$([^\]-]*)(?:-[^\]]*)?\]/g, '$1')  // [$₽-419] → ₽
    .replace(/\[[^\]]*\]/g, '')                      // [Red], [>100] — игнорируем
    .replace(/"([^"]*)"/g, '$1')
    .replace(/\\(.)/g, '$1')
    .replace(/[*_](.)/g, '')                         // заполнитель/отступ — не воспроизводим
    .replace(/%/g, '%');
}

function groupThousands(intStr: string, sep: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function formatNumberSpec(n: number, spec: NumSpec, sep: { group: string; decimal: string }): string {
  // Секция без цифровых плейсхолдеров — показываем только её литерал
  // (типовой случай: «;;"—"» для нулей).
  if (!spec.hasDigits) return spec.prefix + spec.suffix;

  let val = n / spec.scale;
  if (spec.percent) val *= 100;

  const neg = val < 0;
  val = Math.abs(val);

  let s = val.toFixed(spec.decDigits);
  let [ip, dp] = s.split('.');
  if (spec.intDigits > ip.length) ip = ip.padStart(spec.intDigits, '0');
  if (spec.intDigits === 0 && ip === '0' && spec.decDigits > 0) ip = '';
  if (spec.thousands) ip = groupThousands(ip, sep.group);

  s = dp ? ip + sep.decimal + dp : ip;
  return (neg ? '-' : '') + spec.prefix + s + spec.suffix;
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** Применить формат даты/времени к JS-дате. */
function formatDate(d: Date, fmt: string, hasTime: boolean): string {
  const Y = d.getUTCFullYear(), Mo = d.getUTCMonth(), D = d.getUTCDate();
  const H = d.getUTCHours(), Mi = d.getUTCMinutes(), S = d.getUTCSeconds();
  const dow = d.getUTCDay();
  const ampm = /am\/pm|a\/p/i.test(fmt);
  const h12 = H % 12 === 0 ? 12 : H % 12;

  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const rest = fmt.slice(i);

    // Литералы
    if (fmt[i] === '"') {
      const end = fmt.indexOf('"', i + 1);
      out += fmt.slice(i + 1, end < 0 ? fmt.length : end);
      i = end < 0 ? fmt.length : end + 1;
      continue;
    }
    if (fmt[i] === '\\') { out += fmt[i + 1] ?? ''; i += 2; continue; }
    if (fmt[i] === '[') { const end = fmt.indexOf(']', i); i = end < 0 ? fmt.length : end + 1; continue; }

    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^(am\/pm|a\/p)/i))) { out += H < 12 ? 'AM' : 'PM'; i += m[0].length; continue; }
    if ((m = rest.match(/^yyyy/i))) { out += Y; i += 4; continue; }
    if ((m = rest.match(/^yy/i)))   { out += pad2(Y % 100); i += 2; continue; }
    if ((m = rest.match(/^mmmmm/i))){ out += MONTHS_RU[Mo][0].toUpperCase(); i += 5; continue; }
    if ((m = rest.match(/^mmmm/i))) { out += MONTHS_RU[Mo]; i += 4; continue; }
    if ((m = rest.match(/^mmm/i)))  { out += MONTHS_SHORT_RU[Mo]; i += 3; continue; }
    if ((m = rest.match(/^dddd/i))) { out += DAYS_RU[dow]; i += 4; continue; }
    if ((m = rest.match(/^ddd/i)))  { out += DAYS_SHORT_RU[dow]; i += 3; continue; }
    if ((m = rest.match(/^dd/i)))   { out += pad2(D); i += 2; continue; }
    if ((m = rest.match(/^d/i)))    { out += D; i += 1; continue; }
    if ((m = rest.match(/^hh/i)))   { out += pad2(ampm ? h12 : H); i += 2; continue; }
    if ((m = rest.match(/^h/i)))    { out += (ampm ? h12 : H); i += 1; continue; }
    if ((m = rest.match(/^ss/i)))   { out += pad2(S); i += 2; continue; }
    if ((m = rest.match(/^s/i)))    { out += S; i += 1; continue; }

    // «mm» — минуты, если рядом есть часы или секунды; иначе месяц
    if ((m = rest.match(/^mm/i))) {
      const before = fmt.slice(Math.max(0, i - 3), i);
      const after = fmt.slice(i + 2, i + 5);
      const isMinute = /[hH]\W*$/.test(before) || /^\W*[sS]/.test(after);
      out += isMinute ? pad2(Mi) : pad2(Mo + 1);
      i += 2; continue;
    }
    if ((m = rest.match(/^m/i))) {
      const before = fmt.slice(Math.max(0, i - 3), i);
      const isMinute = /[hH]\W*$/.test(before);
      out += isMinute ? Mi : (Mo + 1);
      i += 1; continue;
    }

    out += fmt[i]; i++;
  }
  void hasTime;
  return out;
}

export interface FormatOpts {
  /** Разделители группы разрядов и дробной части. По умолчанию русские. */
  group?: string;
  decimal?: string;
}

/**
 * Отформатировать «сырое» значение ячейки для показа пользователю.
 *
 * @param raw  сырое значение: число строкой, ISO-дата, текст
 * @param type тип ячейки
 * @param fmt  код формата Excel (`nf`); пусто или `General` → без формата
 */
export function formatCellValue(
  raw: string,
  type: CellType | undefined,
  fmt: string | undefined,
  opts: FormatOpts = {},
): string {
  if (raw === '' || raw == null) return '';
  const sep = { group: opts.group ?? ' ', decimal: opts.decimal ?? ',' };

  // Без формата — показываем как есть (числа при этом остаются машинными,
  // это осознанно: General в Excel тоже не группирует разряды).
  if (!fmt || fmt === 'General' || fmt === '@') {
    if (type === 'd') {
      const d = new Date(raw);
      return isNaN(d.getTime()) ? raw : formatDate(d, 'dd.mm.yyyy', false);
    }
    return raw;
  }

  if (type === 'd' || isDateFormat(fmt)) {
    let d: Date;
    if (type === 'd') d = new Date(raw);
    else {
      const n = parseFloat(raw);
      if (isNaN(n)) return raw;
      d = serialToDate(n);
    }
    if (isNaN(d.getTime())) return raw;
    const sections = splitSections(fmt);
    return formatDate(d, sections[0], /[hHsS]/.test(fmt));
  }

  const n = parseFloat(raw);
  if (isNaN(n)) {
    // Текст в числовом формате — четвёртая секция, если она есть
    const sections = splitSections(fmt);
    if (sections.length >= 4) return unescapeLiterals(sections[3]).replace(/@/g, raw);
    return raw;
  }

  const sections = splitSections(fmt);
  let sec: string;
  if (n < 0 && sections.length >= 2) {
    // У отрицательной секции знак задаётся самой маской
    const spec = parseNumericSection(sections[1]);
    return formatNumberSpec(Math.abs(n), spec, sep);
  }
  if (n === 0 && sections.length >= 3) sec = sections[2];
  else sec = sections[0];

  return formatNumberSpec(n, parseNumericSection(sec), sep);
}

/**
 * Разобрать введённый пользователем текст обратно в сырое значение.
 * Возвращает null, если это не число в текущей локали.
 */
export function parseUserNumber(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  // Убираем пробелы-разделители разрядов, неразрывные пробелы и валютные знаки
  const cleaned = t
    .replace(/[\s  ]/g, '')
    .replace(/[₽$€£¥]/g, '')
    .replace(/%$/, '')
    .replace(',', '.');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  return t.trim().endsWith('%') ? n / 100 : n;
}

/** Готовые форматы для кнопок панели инструментов. */
export const PRESET_FORMATS: Record<string, string> = {
  general:  'General',
  number:   '#,##0.00',
  integer:  '#,##0',
  currency: '#,##0.00\\ "₽"',
  percent:  '0.00%',
  date:     'dd.mm.yyyy',
  datetime: 'dd.mm.yyyy hh:mm',
  text:     '@',
};
