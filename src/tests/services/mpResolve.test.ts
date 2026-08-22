import { describe, it, expect } from 'vitest';
import { mpResolveStore, mpMatchScore, MP_LABEL, StoreAmbiguousError } from '@/services/aiPageCapabilities';

const S = (id: string, name: string) => ({ id, name });

describe('mpResolveStore — выбор магазина для операций записи', () => {
  it('единственный магазин выбирается без подсказки', () => {
    expect(mpResolveStore([S('1', 'Основной')], undefined, 'ozon').id).toBe('1');
  });

  it('несколько магазинов без подсказки — StoreAmbiguousError с перечнем магазинов', () => {
    const stores = [S('1', 'Основной'), S('2', 'Электроника')];
    let err: unknown;
    try { mpResolveStore(stores, undefined, 'yandex'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StoreAmbiguousError);
    const ambig = err as StoreAmbiguousError;
    expect(ambig.mp).toBe('yandex');
    expect(ambig.stores.map(s => s.name)).toContain('Основной');
    expect(ambig.stores.map(s => s.name)).toContain('Электроника');
  });

  it('подсказка выбирает магазин по части имени, без учёта регистра', () => {
    const stores = [S('1', 'Основной'), S('2', 'Электроника')];
    expect(mpResolveStore(stores, 'электрон', 'wb').id).toBe('2');
    expect(mpResolveStore(stores, 'ЭЛЕКТРОНИКА', 'wb').id).toBe('2');
  });

  it('точное совпадение имени выигрывает у частичного', () => {
    const stores = [S('1', 'Склад'), S('2', 'Склад Москва')];
    expect(mpResolveStore(stores, 'Склад', 'ozon').id).toBe('1');
  });

  it('неоднозначная подсказка — StoreAmbiguousError перечисляет только подходящие', () => {
    const stores = [S('1', 'Склад Москва'), S('2', 'Склад Питер'), S('3', 'Розница')];
    let err: unknown;
    try { mpResolveStore(stores, 'склад', 'ozon'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StoreAmbiguousError);
    const ambig = err as StoreAmbiguousError;
    const names = ambig.stores.map(s => s.name);
    expect(names).toContain('Склад Москва');
    expect(names).toContain('Склад Питер');
    expect(names).not.toContain('Розница');
  });

  it('несуществующий магазин — ошибка перечисляет доступные', () => {
    const stores = [S('1', 'Основной')];
    expect(() => mpResolveStore(stores, 'Автозапчасти', 'wb'))
      .toThrow(/не найден.*Основной/s);
  });

  it('нет магазинов вообще — ошибка ведёт в раздел подключения', () => {
    expect(() => mpResolveStore([], undefined, 'ozon')).toThrow(/Нет подключённых магазинов Ozon/);
  });

  it('пустая подсказка не считается подсказкой', () => {
    expect(mpResolveStore([S('1', 'Основной')], '  ', 'ozon').id).toBe('1');
  });

  it('каждый маркетплейс назван по-русски в тексте ошибки', () => {
    expect(MP_LABEL.ozon).toBe('Ozon');
    expect(MP_LABEL.wb).toBe('Wildberries');
    expect(MP_LABEL.yandex).toBe('Яндекс Маркет');
  });
});

describe('mpMatchScore — ранжирование товаров при поиске', () => {
  it('точный артикул набирает максимум', () => {
    expect(mpMatchScore('abc-1', 'ABC-1', 'Чехол', [])).toBe(100);
  });

  it('точный alt-id (nm_id / market_sku) тоже максимум', () => {
    expect(mpMatchScore('12345', 'ABC-1', 'Чехол', ['12345'])).toBe(100);
  });

  it('точное совпадение приоритетнее вхождения — выбирается верный товар', () => {
    const exact = mpMatchScore('abc-1', 'ABC-1', 'Чехол', []);
    const prefix = mpMatchScore('abc-1', 'ABC-10', 'Чехол', []);
    expect(exact).toBeGreaterThan(prefix);
  });

  it('совпадение по артикулу весомее совпадения по названию', () => {
    const byArticle = mpMatchScore('чехол', 'чехол', 'Товар', []);
    const byName = mpMatchScore('чехол', 'XR-99', 'Чехол силиконовый', []);
    expect(byArticle).toBeGreaterThan(byName);
  });

  it('нерелевантный запрос даёт 0 и товар не попадёт в выдачу', () => {
    expect(mpMatchScore('зонт', 'ABC-1', 'Чехол', ['999'])).toBe(0);
  });

  it('пустой запрос ничего не матчит', () => {
    expect(mpMatchScore('', 'ABC-1', 'Чехол', [])).toBe(0);
  });

  it('пустые поля товара не дают ложного совпадения', () => {
    expect(mpMatchScore('abc', '', '', [])).toBe(0);
    expect(mpMatchScore('abc', '', '', [''])).toBe(0);
  });
});
