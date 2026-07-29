/**
 * mpProductPush — отправка изменений товарной карточки обратно на маркетплейс.
 *
 * Вызывается после saveProduct() если товар из авто-синхронизированной группы.
 * Поддерживает: Ozon (все атрибуты + цена), Яндекс Маркет (все поля).
 *
 * Данные для API хранятся в скрытых полях _ozon_ и _ym_ в product.data.
 */
import { debug } from '@/utils/debug';


const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Словарь атрибутов Ozon: attribute_id → Map<value_text, dictionary_value_id> ──
// Кешируем чтобы не дёргать API на каждое сохранение
const dictValueCache = new Map<number, Map<string, number>>();

/**
 * Получить словарные значения атрибута Ozon.
 * Возвращает Map<text_value_lowercase, dictionary_value_id>
 */
async function getOzonDictValues(
  attributeId: number,
  categoryId: number,
  creds: { client_id: string; api_key: string },
): Promise<Map<string, number>> {
  if (dictValueCache.has(attributeId)) return dictValueCache.get(attributeId)!;

  const map = new Map<string, number>();
  let lastValueId = 0;
  try {
    for (let page = 0; page < 20; page++) {
      const body: any = {
        description_category_id: categoryId,
        attribute_id: attributeId,
        language: 'RU',
        limit: 5000,
      };
      if (lastValueId) body.last_value_id = lastValueId;

      const res = await fetch('/ozon-api/v1/description-category/attribute/values', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': creds.client_id,
          'Api-Key': creds.api_key,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) break;
      const data = await res.json();
      const items: any[] = data.result || [];
      for (const item of items) {
        if (item.value) map.set(item.value.toLowerCase(), item.id);
      }
      if (!data.has_next || items.length === 0) break;
      lastValueId = items[items.length - 1].id;
      await sleep(200);
    }
  } catch (e) {
    console.warn('[mpPush] getOzonDictValues error:', e);
  }
  dictValueCache.set(attributeId, map);
  return map;
}

// ── Push на Ozon ────────────────────────────────────────────────────────────────

export interface OzonPushResult {
  ok: boolean;
  priceOk: boolean;
  attrsOk: boolean;
  errors: string[];
}

/**
 * Отправить изменения товара обратно на Ozon.
 * data — текущие данные из product.data (включая _ozon_* поля).
 * prevData — предыдущие данные (чтобы отправлять только изменённые поля).
 */
export async function pushToOzon(
  data: Record<string, any>,
  prevData: Record<string, any>,
  storeCredsFallback?: { client_id: string; api_key: string },
): Promise<OzonPushResult> {
  const result: OzonPushResult = { ok: false, priceOk: false, attrsOk: false, errors: [] };

  const offerId    = String(data['Артикул*'] || data['Артикул'] || '').trim();
  const productId  = parseInt(data['_ozon_product_id'] || '0') || null;
  const categoryId = parseInt(data['_ozon_category_id'] || '0') || 0;
  const storeId    = data['_ozon_store_id'] || '';

  if (!offerId) { result.errors.push('Нет артикула'); return result; }

  // Получаем creds из магазина
  let creds = storeCredsFallback;
  if (!creds && storeId) {
    try {
      const { ozonDb } = await import('./ozonDb');
      const stores = await ozonDb.getStores();
      const store = (stores as any[]).find((s: any) => s.id === storeId);
      if (store) creds = { client_id: store.client_id, api_key: store.api_key };
    } catch (e) { debug.warn('[mpProductPush] swallowed error', e); }
  }
  if (!creds) { result.errors.push('Нет данных магазина Ozon'); return result; }

  // Парсим мета-данные атрибутов
  let attrMeta: Record<string, { attribute_id: number; dictionary_value_id?: number; is_collection: boolean }> = {};
  try {
    if (data['_ozon_attr_meta']) attrMeta = JSON.parse(data['_ozon_attr_meta']);
  } catch (e) { debug.warn('[mpProductPush] swallowed error', e); }

  // ── 1. Цена ────────────────────────────────────────────────────────────────
  const priceNew  = String(data['Цена, руб.*'] || '').trim();
  const pricePrev = String(prevData['Цена, руб.*'] || '').trim();
  const oldPriceNew  = String(data['Старая цена, руб.'] || '').trim();
  const oldPricePrev = String(prevData['Старая цена, руб.'] || '').trim();
  const minPriceNew  = String(data['Мин. цена, руб.'] || data['Минимальная цена, руб.'] || '').trim();

  if (priceNew && (priceNew !== pricePrev || oldPriceNew !== oldPricePrev)) {
    try {
      const { ozonApi } = await import('./ozonApi');
      await ozonApi.updatePrices(creds as any, [{
        offer_id: offerId,
        price: priceNew,
        old_price: oldPriceNew || undefined,
        min_price: minPriceNew || undefined,
      }]);
      result.priceOk = true;
    } catch (e: unknown) {
      result.errors.push(`Цена: ${(e instanceof Error ? e.message : String(e))?.slice(0, 80)}`);
    }
  } else {
    result.priceOk = true; // не изменилась — ОК
  }

  // ── 2. Атрибуты карточки ───────────────────────────────────────────────────
  // Собираем только изменённые атрибуты
  const changedAttrs: any[] = [];

  for (const [fieldName, meta] of Object.entries(attrMeta)) {
    const newVal  = String(data[fieldName] ?? '').trim();
    const prevVal = String(prevData[fieldName] ?? '').trim();
    if (newVal === prevVal) continue; // не изменилось
    if (!newVal) continue;

    let dictValueId: number | undefined;

    // Если атрибут словарный — ищем dictionary_value_id по тексту
    if (meta.dictionary_value_id !== undefined) {
      try {
        const dictMap = await getOzonDictValues(meta.attribute_id, categoryId, creds);
        dictValueId = dictMap.get(newVal.toLowerCase());
        if (!dictValueId) {
          // Попробуем частичное совпадение
          for (const [key, val] of dictMap) {
            if (key.includes(newVal.toLowerCase()) || newVal.toLowerCase().includes(key)) {
              dictValueId = val;
              break;
            }
          }
        }
        if (!dictValueId) {
          result.errors.push(`«${fieldName}»: значение «${newVal}» не найдено в словаре Ozon`);
          continue;
        }
      } catch (e) { debug.warn('[mpProductPush] swallowed error', e); }
    }

    changedAttrs.push({
      attribute_id: meta.attribute_id,
      complex_id: 0,
      values: [{
        value: newVal,
        ...(dictValueId !== undefined ? { dictionary_value_id: dictValueId } : {}),
      }],
    });
  }

  // Название и описание — через /v3/product/update
  const nameNew  = String(data['Название товара*'] || data['Название товара'] || '').trim();
  const namePrev = String(prevData['Название товара*'] || prevData['Название товара'] || '').trim();

  if ((nameNew && nameNew !== namePrev) || changedAttrs.length > 0) {
    try {
      const { ozonApi } = await import('./ozonApi');

      // Получаем текущую полную карточку для merge
      const fullInfo = await ozonApi.getFullProductInfo(offerId, productId, creds as any);
      if (fullInfo) {
        // Merge атрибутов: берём все текущие, заменяем изменённые
        const existingAttrs: any[] = fullInfo.attributes || [];
        const changedIds = new Set(changedAttrs.map((a: any) => a.attribute_id));
        const mergedAttrs = [
          ...existingAttrs.filter((a: any) => !changedIds.has(a.attribute_id)),
          ...changedAttrs,
        ];

        await ozonApi.updateProduct(creds as any, {
          offer_id: offerId,
          name: nameNew || fullInfo.name,
          description_category_id: categoryId || fullInfo.description_category_id,
          type_id: fullInfo.type_id || 0,
          price: priceNew || String(fullInfo.price || '0'),
          old_price: oldPriceNew || String(fullInfo.old_price || '0'),
          vat: fullInfo.vat || '0',
          images: fullInfo.images || [],
          attributes: mergedAttrs,
          dimension_unit: fullInfo.dimension_unit || 'mm',
          weight_unit: fullInfo.weight_unit || 'g',
        });
      } else if (changedAttrs.length > 0) {
        // Если не получили fullInfo — отправляем только изменённые атрибуты
        await ozonApi.updateAttributes(creds as any, [{
          offer_id: offerId,
          attributes: changedAttrs,
        }]);
      }
      result.attrsOk = true;
    } catch (e: unknown) {
      result.errors.push(`Атрибуты: ${(e instanceof Error ? e.message : String(e))?.slice(0, 100)}`);
    }
  } else {
    result.attrsOk = true;
  }

  result.ok = result.errors.length === 0;
  return result;
}

// ── Push на Яндекс Маркет ───────────────────────────────────────────────────────

export interface YMPushResult {
  ok: boolean;
  errors: string[];
}

/**
 * Отправить изменения товара обратно на Яндекс Маркет.
 */
export async function pushToYandex(
  data: Record<string, any>,
  prevData: Record<string, any>,
): Promise<YMPushResult> {
  const result: YMPushResult = { ok: false, errors: [] };

  const offerId    = String(data['Артикул*'] || data['Артикул'] || '').trim();
  const businessId = parseInt(data['_ym_business_id'] || '0') || null;
  const campaignId = parseInt(data['_ym_campaign_id'] || '0') || null;
  const apiKey     = String(data['_ym_api_key'] || '').trim();

  if (!offerId)    { result.errors.push('Нет артикула'); return result; }
  if (!businessId) { result.errors.push('Нет Business ID'); return result; }
  if (!apiKey)     { result.errors.push('Нет API Key'); return result; }

  try {
    const { yandexApi } = await import('./yandexApi');

    // Строим объект оффера из изменённых полей
    const offer: Record<string, any> = { offerId };

    const nameNew  = String(data['Название товара*'] || data['Название товара'] || '').trim();
    const namePrev = String(prevData['Название товара*'] || prevData['Название товара'] || '').trim();
    if (nameNew && nameNew !== namePrev) offer['name'] = nameNew;

    const descNew  = String(data['Описание'] || '').trim();
    const descPrev = String(prevData['Описание'] || '').trim();
    if (descNew !== descPrev) offer['description'] = descNew;

    const vendorNew  = String(data['Бренд'] || '').trim();
    const vendorPrev = String(prevData['Бренд'] || '').trim();
    if (vendorNew && vendorNew !== vendorPrev) offer['vendor'] = vendorNew;

    const vendorCodeNew  = String(data['Артикул производителя'] || '').trim();
    const vendorCodePrev = String(prevData['Артикул производителя'] || '').trim();
    if (vendorCodeNew && vendorCodeNew !== vendorCodePrev) offer['vendorCode'] = vendorCodeNew;

    // Характеристики (parameterValues) — собираем изменённые
    const changedParams: Array<{ parameterName: string; value: { value: string } }> = [];
    const ymInternalKeys = new Set([
      'Артикул*', 'Артикул', 'Название товара*', 'Название товара', 'Бренд', 'Артикул производителя',
      'Описание', 'Цена, руб.*', 'Валюта цены', 'Остаток (всего)', 'Остаток (доступно)',
      'Ссылка на главное фото*', 'SKU на Маркете', 'ID категории ЯМ', 'Категория',
    ]);
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith('_ym_') || key.startsWith('_ozon_') || ymInternalKeys.has(key)) continue;
      if (key.startsWith('Дополнительное фото') || key.startsWith('Вес') || key.startsWith('Длина') || key.startsWith('Ширина') || key.startsWith('Высота')) continue;
      const prev = String(prevData[key] ?? '').trim();
      const cur  = String(val ?? '').trim();
      if (cur !== prev && cur) {
        changedParams.push({ parameterName: key, value: { value: cur } });
      }
    }
    if (changedParams.length > 0) offer['parameterValues'] = changedParams;

    // Габариты
    const dims = ['Вес с упаковкой (кг)', 'Ширина упаковки (см)', 'Длина упаковки (см)', 'Высота упаковки (см)'];
    const dimKeys = ['weight', 'width', 'length', 'height'];
    const weightDimensions: Record<string, number> = {};
    let dimsChanged = false;
    dims.forEach((d, i) => {
      const newV = parseFloat(String(data[d] || ''));
      const prvV = parseFloat(String(prevData[d] || ''));
      if (!isNaN(newV) && newV !== prvV) { weightDimensions[dimKeys[i]] = newV; dimsChanged = true; }
      else if (!isNaN(newV)) weightDimensions[dimKeys[i]] = newV;
    });
    if (dimsChanged) offer['weightDimensions'] = weightDimensions;

    // Фото
    const mainPhotoNew  = String(data['Ссылка на главное фото*'] || '').trim();
    const mainPhotoPrev = String(prevData['Ссылка на главное фото*'] || '').trim();
    if (mainPhotoNew && mainPhotoNew !== mainPhotoPrev) {
      const extras: string[] = [];
      let i = 1;
      while (data[`Дополнительное фото ${i}`]) {
        extras.push(String(data[`Дополнительное фото ${i}`]));
        i++;
      }
      offer['pictures'] = [mainPhotoNew, ...extras].filter(Boolean);
    }

    if (Object.keys(offer).length <= 1) {
      // Только offerId — ничего не изменилось
      result.ok = true;
      return result;
    }

    // Цена — отдельный метод
    const priceNew  = parseFloat(String(data['Цена, руб.*'] || ''));
    const pricePrev = parseFloat(String(prevData['Цена, руб.*'] || ''));
    if (!isNaN(priceNew) && priceNew !== pricePrev && campaignId) {
      try {
        await yandexApi.updateOfferPrices(apiKey, String(campaignId), [{
          offerId,
          price: priceNew,
        }]);
      } catch (e: unknown) {
        result.errors.push(`Цена ЯМ: ${(e instanceof Error ? e.message : String(e))?.slice(0, 80)}`);
      }
    }

    // Основные поля оффера
    await (yandexApi as any).updateOffer(apiKey, businessId, offer);
    result.ok = true;
  } catch (e: unknown) {
    result.errors.push((e instanceof Error ? e.message : String(e))?.slice(0, 120));
  }

  return result;
}

/**
 * Универсальный push — определяет маркетплейс по _ozon_store_id / _ym_store_id.
 * Возвращает null если товар не из авто-синхронизированной группы.
 */
export async function pushProductChanges(
  data: Record<string, any>,
  prevData: Record<string, any>,
): Promise<{ mp: 'ozon' | 'ym'; ok: boolean; errors: string[] } | null> {
  const hasOzon = !!(data['_ozon_store_id'] && data['_ozon_product_id']);
  const hasYM   = !!(data['_ym_store_id'] && data['_ym_business_id']);

  if (hasOzon) {
    const r = await pushToOzon(data, prevData);
    return { mp: 'ozon', ok: r.ok, errors: r.errors };
  }
  if (hasYM) {
    const r = await pushToYandex(data, prevData);
    return { mp: 'ym', ok: r.ok, errors: r.errors };
  }
  return null;
}
