/**
 * Единицы измерения веса/габаритов товаров.
 *
 * База системы (Ozon): размеры в мм, вес в граммах.
 * При сохранении в конкретный МП автоматически конвертируется.
 *
 * Источники по документациям:
 *  - Ozon /v3/product/import — поля `weight` (по `weight_unit` g|kg|lb), `depth`/`width`/`height` (по `dimension_unit` mm|cm|in).
 *  - Wildberries /content/v2/cards/upload — `dimensions: { length, width, height }` в **см** (целые), `weight` берётся из характеристик в **кг**.
 *  - Яндекс Маркет /businesses/{id}/offer-mappings/update — `weightDimensions: { length, width, height, weight }` в **см** и **кг**.
 */

export type Mp = 'ozon' | 'wb' | 'yandex';

/** Единое представление габаритов внутри системы (база — Ozon). */
export interface Dimensions {
  /** Вес, граммы (база). */
  weight_g: number | null;
  /** Длина, мм. */
  length_mm: number | null;
  /** Ширина, мм. */
  width_mm: number | null;
  /** Высота, мм. */
  height_mm: number | null;
}

/** Пустая структура — все null. */
export function emptyDimensions(): Dimensions {
  return { weight_g: null, length_mm: null, width_mm: null, height_mm: null };
}

/** Все ли поля заполнены. */
export function isComplete(d: Dimensions): boolean {
  return d.weight_g != null && d.length_mm != null && d.width_mm != null && d.height_mm != null;
}

/** Все ли поля пустые. */
export function isEmpty(d: Dimensions): boolean {
  return d.weight_g == null && d.length_mm == null && d.width_mm == null && d.height_mm == null;
}

// ── Конвертация в формат конкретного МП ──────────────────────────────────────

/** Ozon: weight (г), depth/width/height (мм). */
export interface OzonDims {
  weight: number | null;
  weight_unit: 'g';
  depth: number | null;
  width: number | null;
  height: number | null;
  dimension_unit: 'mm';
}
export function toOzon(d: Dimensions): OzonDims {
  return {
    weight: d.weight_g,
    weight_unit: 'g',
    depth: d.length_mm,
    width: d.width_mm,
    height: d.height_mm,
    dimension_unit: 'mm',
  };
}

/** WB: length/width/height (см), weight (кг). */
export interface WbDims {
  length: number | null;  // см
  width: number | null;   // см
  height: number | null;  // см
  weight_kg: number | null;
}
export function toWb(d: Dimensions): WbDims {
  return {
    length: d.length_mm != null ? +(d.length_mm / 10).toFixed(1) : null,
    width:  d.width_mm  != null ? +(d.width_mm  / 10).toFixed(1) : null,
    height: d.height_mm != null ? +(d.height_mm / 10).toFixed(1) : null,
    weight_kg: d.weight_g != null ? +(d.weight_g / 1000).toFixed(3) : null,
  };
}

/** Яндекс Маркет: length/width/height (см), weight (кг). */
export interface YmDims {
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null; // кг
}
export function toYm(d: Dimensions): YmDims {
  return {
    length: d.length_mm != null ? +(d.length_mm / 10).toFixed(2) : null,
    width:  d.width_mm  != null ? +(d.width_mm  / 10).toFixed(2) : null,
    height: d.height_mm != null ? +(d.height_mm / 10).toFixed(2) : null,
    weight: d.weight_g  != null ? +(d.weight_g  / 1000).toFixed(3) : null,
  };
}

// ── Обратная конвертация: МП → unified ───────────────────────────────────────

/** Из Ozon (с учётом возможных weight_unit/dimension_unit). */
export function fromOzon(raw: {
  weight?: number | null;
  weight_unit?: string | null;
  depth?: number | null;
  width?: number | null;
  height?: number | null;
  dimension_unit?: string | null;
}): Dimensions {
  const w = raw.weight ?? null;
  const wu = (raw.weight_unit || 'g').toLowerCase();
  const weight_g = w == null ? null
    : wu === 'kg' ? Math.round(w * 1000)
    : wu === 'lb' ? Math.round(w * 453.59)
    : Math.round(w);

  const du = (raw.dimension_unit || 'mm').toLowerCase();
  const toMm = (v: number | null | undefined) => {
    if (v == null) return null;
    if (du === 'cm') return Math.round(v * 10);
    if (du === 'in') return Math.round(v * 25.4);
    return Math.round(v); // mm
  };

  return {
    weight_g,
    length_mm: toMm(raw.depth),
    width_mm:  toMm(raw.width),
    height_mm: toMm(raw.height),
  };
}

/** Из WB (см + кг → мм + г). */
export function fromWb(raw: {
  length?: number | null; // см
  width?: number | null;
  height?: number | null;
  weight_kg?: number | null;
}): Dimensions {
  return {
    weight_g: raw.weight_kg != null ? Math.round(raw.weight_kg * 1000) : null,
    length_mm: raw.length != null ? Math.round(raw.length * 10) : null,
    width_mm:  raw.width  != null ? Math.round(raw.width  * 10) : null,
    height_mm: raw.height != null ? Math.round(raw.height * 10) : null,
  };
}

/** Из ЯМ (см + кг → мм + г). */
export function fromYm(raw: {
  length?: number | null;
  width?: number | null;
  height?: number | null;
  weight?: number | null; // кг
}): Dimensions {
  return {
    weight_g: raw.weight != null ? Math.round(raw.weight * 1000) : null,
    length_mm: raw.length != null ? Math.round(raw.length * 10) : null,
    width_mm:  raw.width  != null ? Math.round(raw.width  * 10) : null,
    height_mm: raw.height != null ? Math.round(raw.height * 10) : null,
  };
}

// ── Сравнение / детект конфликтов ────────────────────────────────────────────

export interface DimensionsBySource { mp: Mp; storeId: string; storeName: string; dims: Dimensions }

/** Считает что значения «равны», если разница ≤ 5% (мелкие округления при конвертации). */
function approxEq(a: number | null, b: number | null, tol = 0.05): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a === b) return true;
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return true;
  return Math.abs(a - b) / max <= tol;
}

export function dimensionsEqual(a: Dimensions, b: Dimensions): boolean {
  return approxEq(a.weight_g, b.weight_g)
      && approxEq(a.length_mm, b.length_mm)
      && approxEq(a.width_mm, b.width_mm)
      && approxEq(a.height_mm, b.height_mm);
}

/** Какие поля различаются между разными источниками. */
export interface Conflicts {
  weight: boolean;
  length: boolean;
  width: boolean;
  height: boolean;
  any: boolean;
}

export function detectConflicts(sources: DimensionsBySource[]): Conflicts {
  const nonEmpty = sources.filter(s => !isEmpty(s.dims));
  if (nonEmpty.length <= 1) {
    return { weight: false, length: false, width: false, height: false, any: false };
  }
  const fields: Array<keyof Dimensions> = ['weight_g', 'length_mm', 'width_mm', 'height_mm'];
  const out: Conflicts = { weight: false, length: false, width: false, height: false, any: false };
  for (const f of fields) {
    const values = nonEmpty.map(s => s.dims[f]).filter(v => v != null) as number[];
    if (values.length <= 1) continue;
    const distinct = values.some(v => !approxEq(v, values[0]));
    if (distinct) {
      if (f === 'weight_g')  out.weight = true;
      if (f === 'length_mm') out.length = true;
      if (f === 'width_mm')  out.width  = true;
      if (f === 'height_mm') out.height = true;
      out.any = true;
    }
  }
  return out;
}

// ── Форматтеры для UI ────────────────────────────────────────────────────────

export function fmtWeight(g: number | null): string {
  if (g == null) return '—';
  if (g >= 1000) return (g / 1000).toFixed(g % 100 === 0 ? 1 : 2) + ' кг';
  return g + ' г';
}

export function fmtLength(mm: number | null): string {
  if (mm == null) return '—';
  if (mm >= 10) return (mm / 10).toFixed(mm % 10 === 0 ? 0 : 1) + ' см';
  return mm + ' мм';
}

export function fmtDims(d: Dimensions): string {
  if (isEmpty(d)) return '—';
  const parts: string[] = [];
  if (d.length_mm != null) parts.push(fmtLength(d.length_mm));
  if (d.width_mm  != null) parts.push(fmtLength(d.width_mm));
  if (d.height_mm != null) parts.push(fmtLength(d.height_mm));
  const dims = parts.length === 3 ? parts.join(' × ') : parts.join(' × ');
  const w = fmtWeight(d.weight_g);
  return dims ? `${dims} · ${w}` : w;
}
