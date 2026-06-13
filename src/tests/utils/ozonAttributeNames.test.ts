import { describe, it, expect } from 'vitest';
import { getAttrName, mergeAttrNames, OZON_ATTR_NAMES } from '@/utils/ozonAttributeNames';

describe('getAttrName()', () => {
  it('returns API-provided name when available', () => {
    expect(getAttrName(85, 'Бренд товара')).toBe('Бренд товара');
  });

  it('returns built-in dictionary name when API name is absent', () => {
    expect(getAttrName(85)).toBe('Бренд');
    expect(getAttrName(10174)).toBe('Высота, см');
    expect(getAttrName(10175)).toBe('Ширина, см');
    expect(getAttrName(10176)).toBe('Глубина, см');
    expect(getAttrName(6656)).toBe('Материал корпуса');
    expect(getAttrName(9546)).toBe('Стиль дизайна');
    expect(getAttrName(6673)).toBe('Комната');
    expect(getAttrName(6650)).toBe('Назначение (помещение)');
  });

  it('returns "Атрибут {id}" for unknown IDs', () => {
    expect(getAttrName(99999)).toBe('Атрибут 99999');
    expect(getAttrName(12345)).toBe('Атрибут 12345');
  });

  it('ignores API name that looks like a fallback placeholder', () => {
    expect(getAttrName(85, 'Атрибут 85')).toBe('Бренд');
  });

  it('ignores empty or whitespace API name', () => {
    expect(getAttrName(85, '')).toBe('Бренд');
    expect(getAttrName(85, '   ')).toBe('Бренд');
  });

  it('trims whitespace from API name', () => {
    expect(getAttrName(85, '  Бренд товара  ')).toBe('Бренд товара');
  });
});

describe('mergeAttrNames()', () => {
  it('adds new names to the dictionary', () => {
    const map = new Map([[777777, 'Тестовый атрибут']]);
    mergeAttrNames(map);
    expect(OZON_ATTR_NAMES[777777]).toBe('Тестовый атрибут');
    expect(getAttrName(777777)).toBe('Тестовый атрибут');
  });

  it('overwrites existing names with API values', () => {
    const map = new Map([[85, 'Бренд (обновлённый)']]);
    mergeAttrNames(map);
    expect(getAttrName(85)).toBe('Бренд (обновлённый)');
    // restore
    OZON_ATTR_NAMES[85] = 'Бренд';
  });

  it('ignores empty names', () => {
    const originalName = OZON_ATTR_NAMES[10174];
    const map = new Map([[10174, '']]);
    mergeAttrNames(map);
    expect(OZON_ATTR_NAMES[10174]).toBe(originalName);
  });
});
