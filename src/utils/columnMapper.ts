/**
 * Smart column mapper for Ozon ↔ local product data.
 *
 * Problem: Ozon API returns fields like "weight", "width", "height", "depth"
 * but local xlsx templates have columns like "Вес в упаковке, г*",
 * "Ширина упаковки, мм*", "Высота упаковки, мм*" etc.
 *
 * This module resolves the mapping using fuzzy matching.
 */

/** Ozon API field → list of possible local column name fragments (lowercase) */
const OZON_TO_LOCAL_HINTS: Record<string, string[]> = {
  // Prices
  price:     ['цена, руб', 'цена руб', 'цена*', 'цена', 'price'],
  old_price: ['цена до скидки', 'старая цена', 'зачёркнутая цена', 'old_price'],
  min_price: ['мин', 'минимальная цена', 'min_price'],

  // Name / description
  name:        ['название товара', 'название', 'наименование', 'name'],
  description: ['аннотация', 'описание', 'description'],

  // Dimensions — упаковка vs товар
  weight: ['вес в упаковке', 'вес упаковки', 'вес товара', 'weight', 'вес'],
  width:  ['ширина упаковки', 'ширина, мм', 'ширина упак', 'width', 'ширина'],
  height: ['высота упаковки', 'высота, мм', 'высота упак', 'height', 'высота'],
  depth:  ['длина упаковки', 'глубина', 'длина, мм', 'длина упак', 'depth', 'длина'],

  // Identifiers
  barcode:    ['штрихкод', 'ean', 'barcode', 'серийный номер'],
  offer_id:   ['артикул', 'sku', 'offer_id'],
  product_id: ['ozon id', 'product_id', '_ozon_id'],

  // Status / stock (internal fields)
  status:    ['_ozon_status', 'статус'],
  stock_fbs: ['_ozon_fbs', 'fbs'],
  stock_fbo: ['_ozon_fbo', 'fbo'],

  // Category / brand
  category: ['категория', 'тип', 'category'],
  vendor:   ['бренд', 'производитель', 'brand', 'vendor'],
};

/**
 * Find the best matching local column name for a given Ozon field.
 *
 * @param ozonField  - Ozon API field name (e.g. "weight", "width")
 * @param localCols  - Array of local column names from the xlsx template
 * @returns The best matching local column name, or null if no match found
 */
export function findLocalColumn(ozonField: string, localCols: string[]): string | null {
  const hints = OZON_TO_LOCAL_HINTS[ozonField];
  if (!hints) return null;

  const lowerCols = localCols.map(c => ({ original: c, lower: c.toLowerCase() }));

  for (const hint of hints) {
    // Exact substring match
    const exact = lowerCols.find(c => c.lower.includes(hint));
    if (exact) return exact.original;
  }

  return null;
}

/**
 * Build a mapping from Ozon API fields to local column names.
 *
 * @param localCols - All column names available in the local product data
 * @returns Map of ozonField → localColumnName
 */
export function buildColumnMap(localCols: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const ozonField of Object.keys(OZON_TO_LOCAL_HINTS)) {
    const local = findLocalColumn(ozonField, localCols);
    if (local) map.set(ozonField, local);
  }
  return map;
}

/**
 * Apply Ozon product data to local product data using smart column mapping.
 *
 * @param localData  - Current local product data (Record<columnName, value>)
 * @param ozonData   - Data from Ozon API (flat object with known field names)
 * @param skuField   - The local column used as SKU/article identifier
 * @returns Updated local data with Ozon values merged in
 */
export function applyOzonData(
  localData: Record<string, string>,
  ozonData: Record<string, string | number | null | undefined>,
  skuField = 'Артикул*',
): { data: Record<string, string>; mappedFields: string[]; unmappedFields: string[] } {
  const localCols = Object.keys(localData);
  const colMap = buildColumnMap(localCols);
  const updated = { ...localData };
  const mappedFields: string[] = [];
  const unmappedFields: string[] = [];

  for (const [ozonField, ozonValue] of Object.entries(ozonData)) {
    if (ozonValue === null || ozonValue === undefined) continue;
    if (ozonField === 'offer_id') continue; // don't overwrite SKU

    const localCol = colMap.get(ozonField);
    if (localCol && localCol !== skuField) {
      updated[localCol] = String(ozonValue);
      mappedFields.push(`${ozonField} → ${localCol}`);
    } else {
      // Если поле не сопоставлено — сохраняем его с префиксом _, 
      // чтобы оно не превращалось в новую колонку в таблице
      const internalKey = ozonField.startsWith('_') ? ozonField : `_ozon_${ozonField}`;
      updated[internalKey] = String(ozonValue);
      unmappedFields.push(ozonField);
    }
  }

  return { data: updated, mappedFields, unmappedFields };
}

/**
 * Check if a product has been synced with Ozon.
 * A product is considered synced if it has any _ozon_* internal fields.
 */
export function isOzonSynced(data: Record<string, unknown>): boolean {
  return Object.keys(data).some(k => k.startsWith('_ozon_'));
}

/**
 * Get Ozon status from product data.
 */
export function getOzonStatus(data: Record<string, unknown>): string | null {
  return (data['_ozon_status'] as string) || null;
}

/**
 * Get Ozon stock info from product data.
 */
export function getOzonStock(data: Record<string, unknown>): { fbs: number; fbo: number } | null {
  const fbs = data['_ozon_fbs'];
  const fbo = data['_ozon_fbo'];
  if (fbs === undefined && fbo === undefined) return null;
  return {
    fbs: parseInt(String(fbs || '0')) || 0,
    fbo: parseInt(String(fbo || '0')) || 0,
  };
}
