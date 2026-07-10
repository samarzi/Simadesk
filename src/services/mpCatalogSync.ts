/**
 * mpCatalogSync — автосинхронизация товарных карточек из Ozon и Яндекс Маркет
 * в раздел «Товары» (boxes/products).
 *
 * Результат идентичен ручному импорту xlsx-шаблона:
 *  - создаётся/обновляется группа (Box) с пометкой mp_source
 *  - каждый товар хранится как Product с data: { "Название": "...", "Артикул*": "..." ... }
 *  - атрибуты Ozon преобразуются в человекочитаемые имена (через API категорий)
 *
 * Ручной режим (xlsx-импорт) полностью сохраняется и никак не затрагивается.
 */

import { apiService } from './api';
import { ozonApi } from './ozonApi';
import { companyService } from './companyService';
import { dbFetch } from './dbClient';
import { dimensionsDb } from './dimensionsDb';
import { fromOzon, fromWb, fromYm, isEmpty } from './dimensionsUnit';
import type { OzonStore } from '@/types/ozon';
import type { YandexStore } from '@/types/yandex';
import type { Sheet, Product } from '@/types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncProgress {
  stage: string;
  done: number;
  total: number;
}

export interface SyncResult {
  boxId: string;
  boxName: string;
  created: number;   // новых товаров добавлено
  updated: number;   // существующих обновлено
  total: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Кеш: category_id → Map<attribute_id, name> */
const attrNameCache = new Map<number, Map<number, string>>();

/** Получить имена атрибутов для категории Ozon (с кешированием). */
async function getAttrNames(categoryId: number, creds: { client_id: string; api_key: string }, typeId?: number): Promise<Map<number, string>> {
  if (attrNameCache.has(categoryId)) return attrNameCache.get(categoryId)!;
  const map = await ozonApi.getCategoryAttributeNames(categoryId, creds, typeId);
  attrNameCache.set(categoryId, map);
  return map;
}

// ── Ozon Sync ──────────────────────────────────────────────────────────────────

/**
 * Получить полные атрибуты для списка offer_id через /v4/product/info/attributes.
 * Возвращает Map<offer_id, { attributes: any[], description_category_id: number, name: string, images: string[] }>
 */
async function fetchOzonFullAttributes(
  offerIds: string[],
  creds: { client_id: string; api_key: string },
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, { attributes: any[]; description_category_id: number; name: string; images: string[]; barcode: string }>> {
  const result = new Map<string, any>();
  const CHUNK = 100;
  const total = offerIds.length;

  for (let i = 0; i < offerIds.length; i += CHUNK) {
    if (i > 0) await sleep(600);
    const chunk = offerIds.slice(i, i + CHUNK);
    try {
      const resp = await fetch('/ozon-api/v4/product/info/attributes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': creds.client_id,
          'Api-Key': creds.api_key,
        },
        body: JSON.stringify({
          filter: { offer_id: chunk, visibility: 'ALL' },
          limit: CHUNK,
          sort_dir: 'ASC',
        }),
      });
      if (!resp.ok) {
        console.warn('[mpSync] /v4/product/info/attributes HTTP', resp.status);
        onProgress?.(Math.min(i + CHUNK, total), total);
        continue;
      }
      const data = await resp.json();
      const items: any[] = data.result || [];
      for (const item of items) {
        const offerId = item.offer_id || '';
        if (!offerId) continue;
        result.set(offerId, {
          attributes: item.attributes || [],
          description_category_id: item.description_category_id || 0,
          name: item.name || '',
          images: (item.images || []).map((img: any) =>
            typeof img === 'string' ? img : (img.file_name || ''),
          ).filter(Boolean),
          barcode: Array.isArray(item.barcodes) ? (item.barcodes[0] || '') : '',
        });
      }
    } catch (e) {
      console.warn('[mpSync] attributes chunk error:', e);
    }
    onProgress?.(Math.min(i + CHUNK, total), total);
  }
  return result;
}

/**
 * Превратить атрибуты Ozon в data-объект с человекочитаемыми именами.
 * Результат идентичен строке из xlsx-шаблона Ozon.
 */
async function ozonAttrsToData(
  offerId: string,
  attrData: { attributes: any[]; description_category_id: number; name: string; images: string[]; barcode: string },
  basicInfo: { price: number; old_price: number; stock_fbs: number; stock_fbo: number; status: string; product_id: number; type_id?: number; weight?: number | null; weight_unit?: string; depth?: number | null; width?: number | null; height?: number | null; dimension_unit?: string } | undefined,
  creds: { client_id: string; api_key: string },
): Promise<Record<string, any>> {
  const data: Record<string, any> = {};

  // Базовые поля (совпадают с колонками шаблона Ozon)
  data['Артикул*']                = offerId;
  data['Название товара*']        = attrData.name || '';
  if (basicInfo) {
    data['Цена, руб.*']           = basicInfo.price || '';
    data['Цена до скидки, руб.']  = basicInfo.old_price || '';

    // Габариты упаковки: Ozon отдаёт mm + g, конвертируем в см + кг (как у ЯМ и WB)
    if (basicInfo.weight != null) {
      const wu = (basicInfo.weight_unit || 'g').toLowerCase();
      const kg = wu === 'kg' ? basicInfo.weight
               : wu === 'lb' ? basicInfo.weight * 0.45359
               : basicInfo.weight / 1000;
      data['Вес с упаковкой (кг)'] = +kg.toFixed(3);
    }
    const du = (basicInfo.dimension_unit || 'mm').toLowerCase();
    const toCm = (v: number | null | undefined): number | null => {
      if (v == null) return null;
      return du === 'cm' ? +v.toFixed(1) : du === 'mm' ? +(v / 10).toFixed(1) : +(v * 2.54).toFixed(1);
    };
    const depth  = toCm(basicInfo.depth);
    const width  = toCm(basicInfo.width);
    const height = toCm(basicInfo.height);
    if (depth  != null) data['Длина упаковки (см)']  = depth;
    if (width  != null) data['Ширина упаковки (см)'] = width;
    if (height != null) data['Высота упаковки (см)'] = height;
  }
  data['Штрихкод']                = attrData.barcode || '';

  // Фото — главное фото отдельно, дополнительные в одном поле (как в Excel-шаблоне Ozon)
  const imgs = attrData.images.filter(Boolean);
  if (imgs[0]) data['Ссылка на главное фото*'] = imgs[0];
  if (imgs.length > 1) {
    data['Ссылки на дополнительные фото'] = imgs.slice(1).join('\n');
  }

  // Атрибуты категории → имена через API
  const categoryId = attrData.description_category_id;
  let attrNames = new Map<number, string>();
  if (categoryId) {
    try {
      attrNames = await getAttrNames(categoryId, creds, basicInfo?.type_id);
    } catch { /* fallback to attr IDs */ }
  }

  // Хранит мета-данные атрибутов: имя поля → {attribute_id, dictionary_value_id, is_collection}
  // Используется при push изменений обратно на Ozon
  const attrMeta: Record<string, { attribute_id: number; dictionary_value_id?: number; is_collection: boolean }> = {};

  for (const attr of attrData.attributes) {
    const attrId: number = attr.attribute_id || 0;
    if (!attrId) continue;
    const attrName = attrNames.get(attrId) || `attr_${attrId}`;

    const values: any[] = attr.values || [];
    if (values.length === 0) continue;

    const strValues = values
      .map((v: any) => v.value || v.dictionary_value || '')
      .filter(Boolean);

    if (strValues.length === 1) {
      data[attrName] = strValues[0];
    } else if (strValues.length > 1) {
      data[attrName] = strValues.join('; ');
    }

    // Сохраняем мета: первый dictionary_value_id (если словарный атрибут)
    const firstDictId = values[0]?.dictionary_value_id;
    attrMeta[attrName] = {
      attribute_id: attrId,
      dictionary_value_id: firstDictId || undefined,
      is_collection: values.length > 1,
    };
  }

  // Сохраняем мета-данные как скрытые поля (используются при push на Ozon)
  data['_ozon_product_id']  = basicInfo?.product_id ? String(basicInfo.product_id) : '';
  data['_ozon_category_id'] = String(attrData.description_category_id || '');
  data['_ozon_store_id']    = '';  // будет заполнено в syncOzonStore
  data['_ozon_attr_meta']   = JSON.stringify(attrMeta);

  return data;
}

/**
 * Синхронизировать один магазин Ozon → группа в «Товарах».
 */
export async function syncOzonStore(
  store: OzonStore,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncResult> {
  const creds = { client_id: store.client_id, api_key: store.api_key };
  const cid = companyService.getActiveId();
  if (!cid) throw new Error('Нет активной компании');

  // 1. Получить все product_id + offer_id
  onProgress?.({ stage: 'Загружаем список товаров...', done: 0, total: 0 });
  const idList = await ozonApi.getAllProductIds(creds);
  if (!idList.length) return { boxId: '', boxName: store.name, created: 0, updated: 0, total: 0 };

  const total = idList.length;
  const offerIds = idList.map(i => i.offer_id);

  // 2. Базовая инфо (цены, остатки, статус)
  onProgress?.({ stage: 'Загружаем цены и остатки...', done: 0, total });
  const infoMap = await ozonApi.getProductInfo(idList, creds,
    (done) => onProgress?.({ stage: 'Загружаем цены и остатки...', done, total }),
  );
  await ozonApi.overlayPrices(infoMap, creds);
  await ozonApi.overlayStocks(infoMap, creds);

  // 3. Полные атрибуты карточки
  onProgress?.({ stage: 'Загружаем атрибуты карточек...', done: 0, total });
  const attrMap = await fetchOzonFullAttributes(offerIds, creds,
    (done) => onProgress?.({ stage: 'Загружаем атрибуты карточек...', done, total }),
  );

  // 4. Найти или создать группу
  onProgress?.({ stage: 'Подготавливаем группу...', done: total, total });
  const boxes = await apiService.getBoxes();
  let box = boxes.find(b => b.mp_source === 'ozon' && b.mp_store_id === store.id);
  const boxName = `🟠 Ozon: ${store.name}`;

  if (!box) {
    box = await apiService.createBox({
      name: boxName,
      sticker: '🟠',
      company_id: cid,
      mp_source: 'ozon',
      mp_store_id: store.id,
    } as any);
  } else {
    // Обновим название на случай если магазин переименовали
    if (box.name !== boxName) {
      await apiService.updateBox(box.id, { name: boxName } as any);
      box = { ...box, name: boxName };
    }
  }

  // 5. Получить существующие товары группы для определения new/update
  const existingProds = await apiService.getProductsByBox(box.id);
  const existingByOfferId = new Map<string, Product>();
  for (const p of existingProds) {
    const artKey = (p.data as any)?.['Артикул*'] || '';
    if (artKey) existingByOfferId.set(artKey, p);
  }

  // 6. Найти или создать Sheet (лист импорта) для этой синхронизации
  let sheet = await findOrCreateSyncSheet(box.id, 'ozon', store.name);

  // 7. Построить data-объекты для каждого товара
  onProgress?.({ stage: 'Формируем карточки товаров...', done: 0, total });

  const toInsert: Omit<Product, 'id' | 'created_at' | 'updated_at'>[] = [];
  const toUpdate: Array<{ id: string; data: Record<string, any> }> = [];

  let processed = 0;
  for (const offerId of offerIds) {
    const attrData = attrMap.get(offerId);
    const basicInfo = infoMap.get(offerId);
    if (!attrData && !basicInfo) { processed++; continue; }

    const data = attrData
      ? await ozonAttrsToData(offerId, attrData, basicInfo
          ? {
              price: basicInfo.price,
              old_price: basicInfo.old_price,
              stock_fbs: basicInfo.fbs,
              stock_fbo: basicInfo.fbo,
              status: basicInfo.status,
              product_id: basicInfo.product_id,
              type_id: (basicInfo as any).type_id || 0,
              weight: basicInfo.weight,
              weight_unit: basicInfo.weight_unit,
              depth: basicInfo.depth,
              width: basicInfo.width,
              height: basicInfo.height,
              dimension_unit: basicInfo.dimension_unit,
            }
          : undefined, creds)
      : {
          'Артикул*': offerId,
          'Название товара*': basicInfo!.name,
          'Цена, руб.*': basicInfo!.price,
          'Старая цена, руб.': basicInfo!.old_price,
          'Штрихкод': basicInfo!.barcode,
        };

    // Авто-сохраняем габариты в dimensionsDb (эталон для раздела «Каталог»)
    if (basicInfo) {
      const dims = fromOzon({
        weight: basicInfo.weight, weight_unit: basicInfo.weight_unit,
        depth: basicInfo.depth, width: basicInfo.width, height: basicInfo.height,
        dimension_unit: basicInfo.dimension_unit,
      });
      if (!isEmpty(dims)) dimensionsDb.set(offerId, dims);
    }

    // Проставляем store_id (нужен при push изменений обратно на Ozon)
    data['_ozon_store_id'] = store.id;

    const existing = existingByOfferId.get(offerId);
    if (existing) {
      toUpdate.push({ id: existing.id, data });
    } else {
      toInsert.push({ box_id: box.id, sheet_id: sheet.id, data });
    }
    processed++;
    if (processed % 50 === 0) {
      onProgress?.({ stage: 'Формируем карточки товаров...', done: processed, total });
    }
  }

  // 8. Сохранить в Supabase
  onProgress?.({ stage: 'Сохраняем в базу данных...', done: 0, total: toInsert.length + toUpdate.length });

  if (toInsert.length > 0) {
    await apiService.createProductsBatch(toInsert);
  }
  for (let i = 0; i < toUpdate.length; i += 100) {
    const batch = toUpdate.slice(i, i + 100);
    await Promise.all(batch.map(u => apiService.updateProduct(u.id, { data: u.data })));
    onProgress?.({ stage: 'Сохраняем в базу данных...', done: Math.min(i + 100, toUpdate.length), total: toInsert.length + toUpdate.length });
  }

  // 9. Обновить время последней синхронизации
  await dbFetch(`boxes?id=eq.${box.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ mp_last_sync: new Date().toISOString() }),
  });

  onProgress?.({ stage: 'Готово!', done: total, total });

  return {
    boxId: box.id,
    boxName: box.name,
    created: toInsert.length,
    updated: toUpdate.length,
    total,
  };
}

// ── Yandex Market Sync ─────────────────────────────────────────────────────────

/**
 * Синхронизировать один магазин ЯМ → группа в «Товарах».
 */
export async function syncYandexStore(
  store: YandexStore,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncResult> {
  const cid = companyService.getActiveId();
  if (!cid) throw new Error('Нет активной компании');
  if (!store.business_id) throw new Error('У магазина ЯМ не указан Business ID');

  // 1. Загрузить все офферы
  onProgress?.({ stage: 'Загружаем товары с Яндекс Маркет...', done: 0, total: 0 });

  const { fetchAllYandexProducts } = await import('./yandexApi');
  const ymProducts = await fetchAllYandexProducts(store);
  const total = ymProducts.length;

  if (!total) return { boxId: '', boxName: store.name, created: 0, updated: 0, total: 0 };

  // Загружаем расширенные данные оффера (все характеристики)
  onProgress?.({ stage: 'Загружаем полные характеристики...', done: 0, total });
  const fullOffers = await fetchYandexFullOffers(store, onProgress);

  // 2. Найти или создать группу
  onProgress?.({ stage: 'Подготавливаем группу...', done: total, total });
  const boxes = await apiService.getBoxes();
  let box = boxes.find(b => b.mp_source === 'ym' && b.mp_store_id === store.id);
  const boxName = `🟡 ЯМ: ${store.name}`;

  if (!box) {
    box = await apiService.createBox({
      name: boxName,
      sticker: '🟡',
      company_id: cid,
      mp_source: 'ym',
      mp_store_id: store.id,
    } as any);
  }

  // 3. Существующие товары
  const existingProds = await apiService.getProductsByBox(box.id);
  const existingByOfferId = new Map<string, Product>();
  for (const p of existingProds) {
    const artKey = (p.data as any)?.['Артикул*'] || '';
    if (artKey) existingByOfferId.set(artKey, p);
  }

  // 4. Sheet
  const sheet = await findOrCreateSyncSheet(box.id, 'ym', store.name);

  // 5. Построить data-объекты
  const fullMap = new Map(fullOffers.map((o: any) => [o.offerId, o]));

  const toInsert: Omit<Product, 'id' | 'created_at' | 'updated_at'>[] = [];
  const toUpdate: Array<{ id: string; data: Record<string, any> }> = [];

  for (const prod of ymProducts) {
    const fullOffer: any = fullMap.get(prod.offer_id) || {};
    const data = ymOfferToData(prod, fullOffer);

    // Авто-сохраняем габариты в dimensionsDb (эталон для раздела «Каталог»)
    if (fullOffer.weightDimensions) {
      const wd = fullOffer.weightDimensions;
      const dims = fromYm({ weight: wd.weight, length: wd.length, width: wd.width, height: wd.height });
      if (!isEmpty(dims)) dimensionsDb.set(prod.offer_id, dims);
    }

    // Мета для push обратно на ЯМ
    data['_ym_store_id']    = store.id;
    data['_ym_business_id'] = String(store.business_id || '');
    data['_ym_campaign_id'] = String(store.campaign_id || '');
    data['_ym_api_key']     = store.api_key;
    const existing = existingByOfferId.get(prod.offer_id);
    if (existing) {
      toUpdate.push({ id: existing.id, data });
    } else {
      toInsert.push({ box_id: box.id, sheet_id: sheet.id, data });
    }
  }

  // 6. Сохранить
  onProgress?.({ stage: 'Сохраняем в базу данных...', done: 0, total: toInsert.length + toUpdate.length });
  if (toInsert.length > 0) await apiService.createProductsBatch(toInsert);
  for (let i = 0; i < toUpdate.length; i += 100) {
    await Promise.all(toUpdate.slice(i, i + 100).map(u => apiService.updateProduct(u.id, { data: u.data })));
  }

  await dbFetch(`boxes?id=eq.${box.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ mp_last_sync: new Date().toISOString() }),
  });

  onProgress?.({ stage: 'Готово!', done: total, total });
  return { boxId: box.id, boxName: box.name, created: toInsert.length, updated: toUpdate.length, total };
}

/** Загрузить полные данные офферов ЯМ (с характеристиками) */
async function fetchYandexFullOffers(
  store: YandexStore,
  onProgress?: (p: SyncProgress) => void,
): Promise<any[]> {
  const all: any[] = [];
  let token = '';
  let fetched = 0;
  try {
    const { yandexApi } = await import('./yandexApi');
    for (let page = 0; page < 300; page++) {
      const { offers, nextPageToken } = await yandexApi.getOfferMappings(
        store.api_key, store.business_id!, token,
      );
      for (const raw of offers) {
        const offer = raw.offer ?? raw;
        all.push({
          offerId: offer.offerId ?? raw.offerId ?? '',
          ...offer,
          // Характеристики ЯМ хранятся в parameterValues
          parameterValues: offer.parameterValues || [],
        });
      }
      fetched += offers.length;
      onProgress?.({ stage: 'Загружаем полные характеристики...', done: fetched, total: fetched });
      if (!nextPageToken || nextPageToken === token) break;
      token = nextPageToken;
    }
  } catch (e) {
    console.warn('[mpSync] YM full offers error:', e);
  }
  return all;
}

/** Превратить продукт ЯМ в data-объект (совместимый с форматом шаблона ЯМ) */
function ymOfferToData(prod: any, fullOffer: any): Record<string, any> {
  const data: Record<string, any> = {};

  data['Артикул*']              = prod.offer_id || '';
  data['Название товара*']      = prod.name || '';
  data['Бренд']                 = prod.vendor || fullOffer.vendor || '';
  data['Артикул производителя'] = prod.vendor_code || fullOffer.vendorCode || '';

  if (prod.basic_price != null) data['Цена, руб.*'] = prod.basic_price;
  data['Валюта цены']          = prod.basic_currency || 'RUR';

  // Фото — главное отдельно, дополнительные в одном поле
  const pics: string[] = (fullOffer.pictures || prod.pictures || []).filter(Boolean);
  if (pics[0]) data['Ссылка на главное фото*'] = pics[0];
  if (pics.length > 1) {
    data['Ссылки на дополнительные фото'] = pics.slice(1).join('\n');
  }

  // Описание
  if (fullOffer.description) data['Описание'] = fullOffer.description;

  // Категория
  if (fullOffer.category) data['Категория'] = fullOffer.category;

  // Характеристики ЯМ (parameterValues)
  const params: any[] = fullOffer.parameterValues || [];
  for (const param of params) {
    const name = param.parameterName || param.name || `param_${param.parameterId}`;
    const value = param.value?.value ?? param.value ?? '';
    if (name && value !== undefined && value !== '') {
      data[name] = String(value);
    }
  }

  // Дополнительные поля ЯМ
  if (fullOffer.weightDimensions) {
    const wd = fullOffer.weightDimensions;
    if (wd.weight)  data['Вес с упаковкой (кг)'] = wd.weight;
    if (wd.width)   data['Ширина упаковки (см)'] = wd.width;
    if (wd.length)  data['Длина упаковки (см)']  = wd.length;
    if (wd.height)  data['Высота упаковки (см)'] = wd.height;
  }

  if (prod.market_sku)  data['SKU на Маркете']  = prod.market_sku;
  if (prod.category_id) data['ID категории ЯМ'] = prod.category_id;

  return data;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

/** Найти или создать Sheet-запись для автосинхронизации */
async function findOrCreateSyncSheet(
  boxId: string,
  source: 'ozon' | 'ym' | 'wb',
  _storeName: string,
): Promise<Sheet> {
  const sheets = await apiService.getSheetsByBox(boxId);
  const syncFilename = `__mp_sync_${source}__`;
  const existing = sheets.find(s => s.filename === syncFilename);
  if (existing) return existing;

  return apiService.createSheet({
    box_id: boxId,
    filename: syncFilename,
    columns: [],
    template_headers: undefined,
    template_file_b64: undefined,
  });
}

// ── WB Sync ────────────────────────────────────────────────────────────────────

import type { WbStore } from '@/types/wb';

/** Превратить WB-карточку в data-объект (артикул, название, фото, цена, остаток + характеристики) */
function wbCardToData(prod: any, storeId: string): Record<string, any> {
  const data: Record<string, any> = {};
  data['Артикул*']               = prod.vendor_code || '';
  data['Название товара*']       = prod.title || '';
  data['Бренд']                  = prod.brand || '';
  data['Предмет']                = prod.subject || '';
  if (prod.price != null)        data['Цена, руб.']        = prod.price;
  if (prod.discount != null)     data['Скидка, %']         = prod.discount;
  data['NM ID']                  = prod.nm_id || '';

  // Габариты упаковки (те же имена полей что у ЯМ — для единообразия)
  if (prod.weight_kg != null)  data['Вес с упаковкой (кг)'] = prod.weight_kg;
  if (prod.length_cm != null)  data['Длина упаковки (см)']  = prod.length_cm;
  if (prod.width_cm  != null)  data['Ширина упаковки (см)'] = prod.width_cm;
  if (prod.height_cm != null)  data['Высота упаковки (см)'] = prod.height_cm;

  // Фото — главное отдельно, дополнительные в одном поле
  const pics: string[] = prod.pictures || [];
  if (pics[0]) data['Ссылка на главное фото*'] = pics[0];
  if (pics.length > 1) {
    data['Ссылки на дополнительные фото'] = pics.slice(1).join('\n');
  }

  // Мета
  data['_wb_store_id'] = storeId;
  data['_wb_nm_id']    = String(prod.nm_id || '');

  return data;
}

/**
 * Синхронизировать один магазин WB → группа в «Товарах».
 * WB отдаёт карточки через Content API (/content/v2/get/cards/list).
 */
export async function syncWbStore(
  store: WbStore,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncResult> {
  const cid = companyService.getActiveId();
  if (!cid) throw new Error('Нет активной компании');

  onProgress?.({ stage: 'Загружаем карточки товаров WB...', done: 0, total: 0 });

  const { fetchAllWbProducts } = await import('./wbApi');
  const wbProducts = await fetchAllWbProducts(store);
  const total = wbProducts.length;
  if (!total) return { boxId: '', boxName: store.name, created: 0, updated: 0, total: 0 };

  onProgress?.({ stage: 'Подготавливаем группу...', done: total, total });

  // Найти или создать группу
  const boxes = await apiService.getBoxes();
  let box = boxes.find(b => (b.mp_source as string) === 'wb' && b.mp_store_id === store.id);
  const boxName = `🟣 WB: ${store.name}`;

  if (!box) {
    box = await apiService.createBox({
      name: boxName,
      sticker: '🟣',
      company_id: cid,
      mp_source: 'wb' as any,
      mp_store_id: store.id,
    } as any);
  }

  // Существующие товары
  const existingProds = await apiService.getProductsByBox(box.id);
  const existingByVendorCode = new Map<string, Product>();
  for (const p of existingProds) {
    const vc = String((p.data as any)?.['Артикул*'] || '');
    if (vc) existingByVendorCode.set(vc, p);
  }

  const sheet = await findOrCreateSyncSheet(box.id, 'wb', store.name);
  const toInsert: Omit<Product, 'id' | 'created_at' | 'updated_at'>[] = [];
  const toUpdate: Array<{ id: string; data: Record<string, any> }> = [];

  for (const prod of wbProducts) {
    const data = wbCardToData(prod, store.id);

    // Авто-сохраняем габариты в dimensionsDb (эталон для раздела «Каталог»)
    if (prod.vendor_code) {
      const dims = fromWb({ length: prod.length_cm, width: prod.width_cm, height: prod.height_cm, weight_kg: prod.weight_kg });
      if (!isEmpty(dims)) dimensionsDb.set(prod.vendor_code, dims);
    }

    const existing = existingByVendorCode.get(prod.vendor_code);
    if (existing) {
      toUpdate.push({ id: existing.id, data });
    } else {
      toInsert.push({ box_id: box.id, sheet_id: sheet.id, data });
    }
  }

  onProgress?.({ stage: 'Сохраняем в базу данных...', done: 0, total: toInsert.length + toUpdate.length });
  if (toInsert.length > 0) await apiService.createProductsBatch(toInsert);
  for (let i = 0; i < toUpdate.length; i += 100) {
    await Promise.all(toUpdate.slice(i, i + 100).map(u => apiService.updateProduct(u.id, { data: u.data })));
  }

  await dbFetch(`boxes?id=eq.${box.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ mp_last_sync: new Date().toISOString() }),
  });

  onProgress?.({ stage: 'Готово!', done: total, total });
  return { boxId: box.id, boxName: box.name, created: toInsert.length, updated: toUpdate.length, total };
}
