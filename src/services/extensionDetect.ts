/**
 * Определение, установлено ли расширение SimaDesk у пользователя.
 *
 * Расширение инжектит content script (simadesk-bridge), который
 * выставляет window.__SIMADESK_EXTENSION_ID — по нему пингуем
 * background.js через chrome.runtime.sendMessage.
 */

export async function detectSimaDeskExtension(): Promise<boolean> {
  const chrome = (window as any).chrome;
  if (!chrome?.runtime?.sendMessage) return false;

  const extensionId = (window as any).__SIMADESK_EXTENSION_ID;
  if (!extensionId) return false;

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    try {
      chrome.runtime.sendMessage(extensionId, { type: 'ping' }, (res: any) => {
        if (chrome.runtime.lastError) { finish(false); return; }
        finish(res?.type === 'pong');
      });
    } catch { finish(false); }
    setTimeout(() => finish(false), 2000);
  });
}

/** Параметры для проверки точной цены на странице маркетплейса (по одной позиции). */
export interface CheckPriceNowParams {
  marketplace: 'wb' | 'ozon' | 'yandex';
  nmId?: number;
  /** Ozon storefront SKU — для ссылки https://www.ozon.ru/product/{sku}/. */
  sku?: string;
  offerId?: string;
  marketSku?: number;
  /** ID модели Яндекс.Маркета — для точной ссылки product/{modelId}?sku={marketSku}. */
  marketModelId?: number;
  productTitle?: string;
}

export interface CheckPriceNowResult {
  ok: boolean;
  price?: number | null;
  error?: string;
}

/**
 * Просит расширение SimaDesk открыть карточку товара на маркетплейсе и считать
 * текущую витринную цену из DOM (репортится в wb_buyer_prices/ozon_buyer_prices/
 * yandex_buyer_prices). Возвращает найденную цену или ошибку.
 */
export async function checkPriceNow(params: CheckPriceNowParams): Promise<CheckPriceNowResult> {
  const chrome = (window as any).chrome;
  if (!chrome?.runtime?.sendMessage) return { ok: false, error: 'Расширение не найдено' };

  const extensionId = (window as any).__SIMADESK_EXTENSION_ID;
  if (!extensionId) return { ok: false, error: 'Расширение не найдено' };

  return new Promise((resolve) => {
    let done = false;
    const finish = (res: CheckPriceNowResult) => { if (!done) { done = true; resolve(res); } };
    try {
      chrome.runtime.sendMessage(extensionId, { type: 'check-price-now', ...params }, (res: any) => {
        if (chrome.runtime.lastError) { finish({ ok: false, error: chrome.runtime.lastError.message }); return; }
        finish(res ?? { ok: false, error: 'Нет ответа от расширения' });
      });
    } catch (e: any) { finish({ ok: false, error: e?.message ?? String(e) }); }
    setTimeout(() => finish({ ok: false, error: 'Таймаут расширения' }), 25_000);
  });
}
