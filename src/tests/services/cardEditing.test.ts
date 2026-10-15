/**
 * Редактирование карточек через API маркетплейсов: то, что нельзя
 * проверить на живом магазине без риска, — проверяем на подменённых ответах.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ozonApi } from '@/services/ozonApi';
import { wbApi, waitWbPriceTask } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

type Handler = (body: any, url: string) => unknown;
/** Подменить ответы по пути запроса; все вызовы записываются. */
function route(handlers: Record<string, Handler>) {
  const calls: Array<{ path: string; body: any }> = [];
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const key = Object.keys(handlers).find(k => String(url).includes(k));
    calls.push({ path: key ?? String(url), body });
    const data = key ? handlers[key](body, String(url)) : {};
    return {
      ok: true, status: 200,
      headers: { get: (h: string) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
      json: async () => data, text: async () => JSON.stringify(data),
    };
  });
  return calls;
}

const creds = { client_id: '1', api_key: 'k' };

beforeEach(() => {
  mockFetch.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
});

describe('Ozon: фото', () => {
  const card = {
    offer_id: 'A1', primary_image: 'https://o/main.jpg',
    images: ['https://o/main.jpg', 'https://o/2.jpg', 'https://o/3.jpg', 'https://o/6.jpg'],
    images360: [{ file_name: 'https://o/360.jpg' }], color_image: 'https://o/color.jpg',
  };

  it('сохраняет порядок, не теряет фото вне каталога, не возвращает удалённые, передаёт 360 и цвет', async () => {
    const calls = route({
      '/v4/product/info/attributes': () => ({ result: [card] }),
      '/v1/product/pictures/import': () => ({ result: { pictures: [] } }),
      '/v2/product/pictures/info': () => ({ items: [{ product_id: 7, primary_photo: ['https://o/3.jpg'], photo: ['https://o/main.jpg', 'https://o/6.jpg'] }] }),
    });
    // В каталоге SimaDesk было 3 фото (6.jpg не загрузилось); пользователь
    // поставил 3.jpg первым и удалил 2.jpg
    const res = await ozonApi.replacePictures(creds, 7, 'A1', ['https://o/3.jpg', 'https://o/main.jpg'], ['https://o/2.jpg']);
    const imp = calls.find(c => c.path === '/v1/product/pictures/import')!.body;
    expect(imp.images).toEqual(['https://o/3.jpg', 'https://o/main.jpg', 'https://o/6.jpg']);
    expect(imp.images360).toEqual(['https://o/360.jpg']);
    expect(imp.color_image).toBe('https://o/color.jpg');
    expect(imp.product_id).toBe(7);
    expect(res.pending).toBe(false);
    expect(res.images[0]).toBe('https://o/3.jpg');
  });

  it('ошибку загрузки фото показывает, а не молчит', async () => {
    route({
      '/v4/product/info/attributes': () => ({ result: [card] }),
      '/v1/product/pictures/import': () => ({}),
      '/v2/product/pictures/info': () => ({ items: [{ product_id: 7, errors: [{ message: 'image too small' }] }] }),
    });
    await expect(ozonApi.replacePictures(creds, 7, 'A1', ['https://o/main.jpg'])).rejects.toThrow(/image too small/);
  });
});

describe('Ozon: карточка поверх текущей', () => {
  it('меняет только нужные поля, сохраняя характеристики, фото и габариты', async () => {
    const calls = route({
      '/v4/product/info/attributes': () => ({ result: [{
        offer_id: 'A1', name: 'Старое', description_category_id: 5, type_id: 9,
        attributes: [{ id: 85, complex_id: 0, values: [{ dictionary_value_id: 1, value: 'Бренд' }] }, { id: 4191, values: [{ value: 'старое описание' }] }],
        images: ['https://o/1.jpg'], primary_image: 'https://o/0.jpg',
        depth: 300, width: 200, height: 100, dimension_unit: 'mm', weight: 800, weight_unit: 'g',
      }] }),
      '/v3/product/info/list': () => ({ items: [{ price: '1000', old_price: '1500', vat: '0.2' }] }),
      '/v3/product/import': () => ({ result: { task_id: 42 } }),
    });
    const task = await ozonApi.updateCardMerged(creds, 'A1', 7, { name: 'Новое', description: 'новое описание', weight_g: 950 });
    expect(task).toBe(42);
    const item = calls.find(c => c.path === '/v3/product/import')!.body.items[0];
    expect(item.name).toBe('Новое');
    expect(item.attributes).toContainEqual({ id: 85, complex_id: 0, values: [{ dictionary_value_id: 1, value: 'Бренд' }] });
    expect(item.attributes.filter((a: any) => a.id === 4191)).toEqual([{ id: 4191, complex_id: 0, values: [{ value: 'новое описание' }] }]);
    expect(item.images).toEqual(['https://o/1.jpg']);
    expect(item.primary_image).toBe('https://o/0.jpg');
    expect([item.depth, item.width, item.height, item.weight]).toEqual([300, 200, 100, 950]);
    expect(item.price).toBe('1000');
    expect(item.vat).toBe('0.2');
  });

  it('ошибка проверки импорта доходит до пользователя', async () => {
    route({ '/v1/product/import/info': () => ({ result: { items: [{ offer_id: 'A1', status: 'failed', errors: [{ message: 'name too long', level: 'error' }] }] } }) });
    await expect(ozonApi.waitImportTask(creds, 42, 2)).rejects.toThrow(/name too long/);
  });

  it('архив — в формате API { product_id: [...] }', async () => {
    const calls = route({ '/v1/product/archive': () => ({ result: true }) });
    await ozonApi.archiveProducts(creds, [1, 2]);
    expect(calls[0].body).toEqual({ product_id: [1, 2] });
  });
});

describe('WB', () => {
  it('фото — через media/save, а не cards/update', async () => {
    const calls = route({ '/content/v3/media/save': () => ({ error: false }) });
    await wbApi.saveMedia('k', 123, ['https://x/1.jpg', 'https://x/2.jpg']);
    expect(calls[0].path).toBe('/content/v3/media/save');
    expect(calls[0].body).toEqual({ nmId: 123, data: ['https://x/1.jpg', 'https://x/2.jpg'] });
  });

  it('карантин цены по товару возвращается ошибкой', async () => {
    route({
      '/api/v2/history/tasks': () => ({ data: { uploadID: 5, status: 5 } }),
      '/api/v2/history/goods/task': () => ({ data: { historyGoods: [{ nmID: 123, errorText: 'Item has been moved to Price Quarantine' }] } }),
    });
    const errs = await waitWbPriceTask('k', 5, 2);
    expect(errs?.get(123)).toMatch(/Quarantine/);
  });
});

describe('Яндекс Маркет', () => {
  it('status=ERROR в ответе — это ошибка, а не «сохранено»', async () => {
    route({ '/offer-mappings/update': () => ({ status: 'ERROR', results: [{ offerId: 'A1', errors: [{ type: 'INVALID_PICTURE', message: 'bad picture' }] }] }) });
    await expect(yandexApi.updateOffer('k', 1, { offerId: 'A1', pictures: ['x'] })).rejects.toThrow(/bad picture/);
  });
});
