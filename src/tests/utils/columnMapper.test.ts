import { describe, it, expect } from 'vitest';
import { findLocalColumn, buildColumnMap, applyOzonData, isOzonSynced, getOzonStock } from '@/utils/columnMapper';

// ── findLocalColumn ────────────────────────────────────────────────────────

describe('findLocalColumn()', () => {
  const ozonTemplateCols = [
    'Артикул*',
    'Название товара',
    'Цена, руб.*',
    'Цена до скидки, руб.',
    'НДС, %*',
    'Вес в упаковке, г*',
    'Ширина упаковки, мм*',
    'Высота упаковки, мм*',
    'Длина упаковки, мм*',
    'Ссылка на главное фото*',
    'Бренд*',
    'Тип*',
  ];

  it('maps price to "Цена, руб.*"', () => {
    expect(findLocalColumn('price', ozonTemplateCols)).toBe('Цена, руб.*');
  });

  it('maps old_price to "Цена до скидки, руб."', () => {
    expect(findLocalColumn('old_price', ozonTemplateCols)).toBe('Цена до скидки, руб.');
  });

  it('maps weight to "Вес в упаковке, г*"', () => {
    expect(findLocalColumn('weight', ozonTemplateCols)).toBe('Вес в упаковке, г*');
  });

  it('maps width to "Ширина упаковки, мм*"', () => {
    expect(findLocalColumn('width', ozonTemplateCols)).toBe('Ширина упаковки, мм*');
  });

  it('maps height to "Высота упаковки, мм*"', () => {
    expect(findLocalColumn('height', ozonTemplateCols)).toBe('Высота упаковки, мм*');
  });

  it('maps depth to "Длина упаковки, мм*"', () => {
    expect(findLocalColumn('depth', ozonTemplateCols)).toBe('Длина упаковки, мм*');
  });

  it('maps name to "Название товара"', () => {
    expect(findLocalColumn('name', ozonTemplateCols)).toBe('Название товара');
  });

  it('maps vendor to "Бренд*"', () => {
    expect(findLocalColumn('vendor', ozonTemplateCols)).toBe('Бренд*');
  });

  it('returns null for unknown field', () => {
    expect(findLocalColumn('unknown_field_xyz', ozonTemplateCols)).toBeNull();
  });

  it('works with simplified column names (no units)', () => {
    const simpleCols = ['Ширина, см', 'Высота, см', 'Глубина, см', 'Вес товара, г'];
    expect(findLocalColumn('width', simpleCols)).toBe('Ширина, см');
    expect(findLocalColumn('height', simpleCols)).toBe('Высота, см');
    expect(findLocalColumn('depth', simpleCols)).toBe('Глубина, см');
    expect(findLocalColumn('weight', simpleCols)).toBe('Вес товара, г');
  });
});

// ── buildColumnMap ─────────────────────────────────────────────────────────

describe('buildColumnMap()', () => {
  it('builds a map with multiple fields', () => {
    const cols = ['Цена, руб.*', 'Название товара', 'Вес в упаковке, г*'];
    const map = buildColumnMap(cols);
    expect(map.get('price')).toBe('Цена, руб.*');
    expect(map.get('name')).toBe('Название товара');
    expect(map.get('weight')).toBe('Вес в упаковке, г*');
  });
});

// ── applyOzonData ──────────────────────────────────────────────────────────

describe('applyOzonData()', () => {
  it('updates price and name from Ozon data', () => {
    const local = {
      'Артикул*': 'ART-001',
      'Название товара': 'Старое название',
      'Цена, руб.*': '1000',
    };
    const ozon = { price: 1500, name: 'Новое название' };
    const { data, mappedFields } = applyOzonData(local, ozon);
    expect(data['Цена, руб.*']).toBe('1500');
    expect(data['Название товара']).toBe('Новое название');
    expect(data['Артикул*']).toBe('ART-001'); // SKU not overwritten
    expect(mappedFields.length).toBeGreaterThan(0);
  });

  it('does not overwrite SKU field', () => {
    const local = { 'Артикул*': 'MY-SKU', 'Цена, руб.*': '100' };
    const ozon = { offer_id: 'OTHER-SKU', price: 200 };
    const { data } = applyOzonData(local, ozon);
    expect(data['Артикул*']).toBe('MY-SKU');
  });

  it('stores unmapped fields with _ozon_ prefix', () => {
    const local = { 'Артикул*': 'ART-001' };
    const ozon = { status: 'processed', stock_fbs: 5, stock_fbo: 10 };
    const { data, unmappedFields } = applyOzonData(local, ozon);
    expect(data['_ozon_status']).toBe('processed');
    expect(data['_ozon_stock_fbs']).toBe('5');
    expect(unmappedFields).toContain('status');
  });
});

// ── isOzonSynced ───────────────────────────────────────────────────────────

describe('isOzonSynced()', () => {
  it('returns true when _ozon_ fields present', () => {
    expect(isOzonSynced({ '_ozon_status': 'processed' })).toBe(true);
    expect(isOzonSynced({ '_ozon_synced_at': '2026-01-01' })).toBe(true);
  });

  it('returns false when no _ozon_ fields', () => {
    expect(isOzonSynced({ 'Артикул*': 'ART-001', 'Цена, руб.*': '100' })).toBe(false);
    expect(isOzonSynced({})).toBe(false);
  });
});

// ── getOzonStock ───────────────────────────────────────────────────────────

describe('getOzonStock()', () => {
  it('returns stock values when present', () => {
    const result = getOzonStock({ '_ozon_fbs': '5', '_ozon_fbo': '10' });
    expect(result).toEqual({ fbs: 5, fbo: 10 });
  });

  it('returns null when no stock fields', () => {
    expect(getOzonStock({ 'Артикул*': 'ART-001' })).toBeNull();
  });
});
