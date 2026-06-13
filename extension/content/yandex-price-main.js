/**
 * SimaDesk — сбор реальной цены покупателя на Yandex Market (MAIN world).
 *
 * Запускается на страницах товара (market.yandex.ru/product/* и /card/*).
 * Реальная цена (с учётом Буста) видна только в настоящем браузере после
 * полной загрузки JS — поэтому это работает только как content script,
 * а не как серверный запрос (там Яндекс отдаёт капчу).
 *
 * Найденную цену отправляет в ISOLATED world через CustomEvent, оттуда —
 * в background.js, который шлёт её в Supabase.
 */

(function () {
  const POLL_INTERVAL_MS = 700;
  const MAX_WAIT_MS = 15000;

  function getMarketSkuFromUrl() {
    const m = location.pathname.match(/(\d{6,})(?:[/?#]|$)/);
    return m ? Number(m[1]) : null;
  }

  function priceFromState() {
    const state = window.state || window.__INITIAL_STATE__;
    if (!state) return [];
    const found = [];
    const seen = new Set();
    const visit = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 8 || seen.has(obj)) return;
      seen.add(obj);
      if (
        typeof obj.value === 'number' &&
        obj.value > 0 &&
        (obj.currency === 'RUR' || obj.currencyId === 'RUR')
      ) {
        found.push(obj.value);
      }
      for (const key of Object.keys(obj)) visit(obj[key], depth + 1);
    };
    visit(state, 0);
    return found;
  }

  function priceFromDom() {
    const selectors = [
      '[data-auto="snippet-price-current"]',
      '[data-auto="mainPrice"] [data-auto="price-value"]',
      '[data-auto="price-value"]',
      '[data-auto="mainPrice"]',
      '[data-zone-name="price"]',
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const t = el.textContent?.trim();
        if (!t) continue;
        const digits = t.replace(/[^\d]/g, '');
        if (digits.length >= 2) return Number(digits);
      }
    }
    return null;
  }

  function getProductTitle() {
    const h1 = document.querySelector('h1');
    return h1?.textContent?.trim() ?? document.title;
  }

  function report(buyerPrice, source) {
    const marketSku = getMarketSkuFromUrl();
    if (!marketSku || !buyerPrice) return;
    window.dispatchEvent(new CustomEvent('sd-yandex-price', {
      detail: {
        marketSku,
        buyerPrice,
        productTitle: getProductTitle(),
        source,
        url: location.href,
      },
    }));
  }

  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += POLL_INTERVAL_MS;

    // "Призрак" / soft-блок — не товар, выходим
    if (document.body?.textContent?.includes('Продавец удалил этот товар')) {
      clearInterval(timer);
      return;
    }

    const domPrice = priceFromDom();
    if (domPrice) {
      clearInterval(timer);
      report(domPrice, 'dom');
      return;
    }

    if (elapsed >= MAX_WAIT_MS) {
      clearInterval(timer);
      const statePrices = priceFromState().filter(v => v > 50 && v < 10_000_000);
      if (statePrices.length > 0) {
        report(Math.min(...statePrices), 'state');
      }
    }
  }, POLL_INTERVAL_MS);
})();
