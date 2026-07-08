/**
 * SimaDesk — сбор реальной цены покупателя на Yandex Market (MAIN world).
 *
 * Нужна цена «без карты» (обычная витринная, без ЯМ Пэй).
 * На странице видна только цена «с Пэй» (зелёная, ниже).
 * Цена «без карты» раскрывается в попапе по клику на шеврон [data-auto="price-details-icon"]
 * или хранится в атрибуте data-zone-data → additionalPrices[withDiscount].
 *
 * Стратегии (в порядке надёжности):
 *   1. data-zone-data → additionalPrices.withDiscount  (без клика, самый надёжный)
 *   2. Попап уже открыт → ищем «без карты» рядом с ценой
 *   3. Кликаем шеврон цены → ждём модал → читаем «без карты»
 *   4. state / __INITIAL_STATE__ (второй по убыванию) — последний шанс
 */

(function () {
  const POLL_INTERVAL_MS = 600;
  const MAX_WAIT_MS = 15000;

  function getMarketSkuFromUrl() {
    const skuParam = new URLSearchParams(location.search).get('sku');
    if (skuParam && /^\d+$/.test(skuParam)) return Number(skuParam);
    const m = location.pathname.match(/(\d{6,})(?:[/?#]|$)/);
    return m ? Number(m[1]) : null;
  }

  function extractNumber(text) {
    if (!text) return 0;
    if (/^[–\-]/.test(text.trim())) return 0;
    const v = Number(text.replace(/[^\d]/g, ''));
    return v > 100 && v < 10_000_000 ? v : 0;
  }

  function isStrikethrough(el) {
    if (el.classList?.contains('ds-text_decoration_line-through')) return true;
    if (el.closest('[class*="line-through"], del, s')) return true;
    if ((el.getAttribute('style') ?? '').includes('line-through')) return true;
    try {
      const cs = window.getComputedStyle(el);
      if ((cs.textDecorationLine || cs.textDecoration || '').includes('line-through')) return true;
    } catch {}
    return false;
  }

  /**
   * Стратегия 1: читаем data-zone-data атрибут — там есть additionalPrices[withDiscount].
   * withDiscount = цена с основной скидкой магазина, без ЯМ Пэй — это и есть «без карты».
   */
  function priceFromDataZone() {
    for (const el of document.querySelectorAll('[data-zone-data]')) {
      let data;
      try { data = JSON.parse(el.getAttribute('data-zone-data') ?? ''); } catch { continue; }
      if (!Array.isArray(data?.additionalPrices)) continue;
      const withDiscount = data.additionalPrices.find(p => p.priceType === 'withDiscount');
      if (withDiscount?.priceValue > 100) return withDiscount.priceValue;
    }
    return null;
  }

  /**
   * Стратегия 2: попап/модал уже открыт — ищем leaf-элемент «без карты»
   * и берём цену из соседнего flex-column.
   */
  function priceWithoutCard() {
    for (const el of document.querySelectorAll('span, div')) {
      if (el.children.length > 0) continue;
      if (el.textContent?.trim() !== 'без карты') continue;
      const col = el.closest('[class*="ds-flex_col"]') ?? el.parentElement?.parentElement;
      if (!col) continue;
      const vl = col.querySelector('[class*="valueLine"]');
      if (!vl) continue;
      const v = extractNumber(vl.textContent ?? '');
      if (v > 0) return v;
    }
    return null;
  }

  /**
   * Стратегия 3 (async): кликаем шеврон → ждём модал → читаем «без карты».
   */
  function priceByClickingDetails() {
    return new Promise(resolve => {
      // Кликабельный блок цены содержит шеврон [data-auto="price-details-icon"]
      // Кликаем по его ближайшему кликабельному предку
      const chevron = document.querySelector('[data-auto="price-details-icon"]');
      const clickTarget = chevron?.closest('[role="button"], button, [tabindex="0"]')
                        ?? chevron?.parentElement
                        ?? document.querySelector('button._3yKNk');

      if (!clickTarget) { resolve(null); return; }
      clickTarget.click();

      let waited = 0;
      const check = setInterval(() => {
        waited += 200;
        const v = priceWithoutCard();
        if (v) {
          clearInterval(check);
          try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
          } catch {}
          resolve(v);
          return;
        }
        if (waited >= 4000) { clearInterval(check); resolve(null); }
      }, 200);
    });
  }

  /**
   * Стратегия 4: стандартные контейнеры ЯМ (fallback).
   */
  function priceFromContainer() {
    const containers = [
      document.querySelector('[data-auto="mainPrice"]'),
      document.querySelector('[data-zone-name="price"]'),
      document.querySelector('[data-auto="snippet-price-current"]'),
    ].filter(Boolean);

    for (const container of containers) {
      const prices = [];
      for (const el of container.querySelectorAll('*')) {
        if (el.children.length > 0) continue;
        if (el.closest('button')) continue;
        if (isStrikethrough(el)) continue;
        const v = extractNumber(el.textContent?.trim() ?? '');
        if (v > 0) prices.push(v);
      }
      if (prices.length > 0) return Math.max(...prices);
    }
    return null;
  }

  function priceFromState() {
    const state = window.state || window.__INITIAL_STATE__;
    if (!state) return [];
    const found = [];
    const seen = new Set();
    const visit = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 8 || seen.has(obj)) return;
      seen.add(obj);
      if (typeof obj.value === 'number' && obj.value > 0 &&
          (obj.currency === 'RUR' || obj.currencyId === 'RUR')) {
        found.push(obj.value);
      }
      for (const key of Object.keys(obj)) visit(obj[key], depth + 1);
    };
    visit(state, 0);
    return found;
  }

  /** Синхронный проход (без клика). */
  function priceFromDom() {
    return priceFromDataZone()
        ?? priceWithoutCard()
        ?? priceFromContainer();
  }

  function getProductTitle() {
    const h1 = document.querySelector('h1');
    return h1?.textContent?.trim() ?? document.title;
  }

  function report(buyerPrice, source) {
    const marketSku = getMarketSkuFromUrl();
    if (!marketSku || !buyerPrice) return;
    window.dispatchEvent(new CustomEvent('sd-yandex-price', {
      detail: { marketSku, buyerPrice, productTitle: getProductTitle(), source, url: location.href },
    }));
  }

  let elapsed = 0;
  let clickAttempted = false;
  let done = false;

  const timer = setInterval(async () => {
    if (done) return;
    elapsed += POLL_INTERVAL_MS;

    if (document.body?.textContent?.includes('Продавец удалил этот товар')) {
      clearInterval(timer);
      return;
    }

    const domPrice = priceFromDom();
    if (domPrice) {
      done = true;
      clearInterval(timer);
      report(domPrice, 'dom');
      return;
    }

    // После 3 сек — пробуем кликнуть шеврон деталей цены
    if (!clickAttempted && elapsed >= 3000) {
      clickAttempted = true;
      const clickPrice = await priceByClickingDetails();
      if (clickPrice && !done) {
        done = true;
        clearInterval(timer);
        report(clickPrice, 'details-click');
      }
      return;
    }

    if (elapsed >= MAX_WAIT_MS) {
      clearInterval(timer);
      const statePrices = priceFromState().filter(v => v > 100 && v < 10_000_000);
      if (statePrices.length > 0) {
        statePrices.sort((a, b) => b - a);
        // Второй по убыванию: самый высокий обычно зачёркнутая «обычная цена»
        report(statePrices.length > 1 ? statePrices[1] : statePrices[0], 'state');
      }
    }
  }, POLL_INTERVAL_MS);
})();
