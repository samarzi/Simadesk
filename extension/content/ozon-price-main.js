/**
 * SimaDesk — сбор реальной цены покупателя на Ozon (MAIN world).
 *
 * Запускается на страницах товара (www.ozon.ru/product/{slug}-{productId}/).
 * Ozon показывает две цены: со скидкой по Ozon Карте (ниже) и обычную,
 * без карты (выше) — нам нужна именно обычная цена, видна только в
 * настоящем браузере после полной загрузки JS.
 *
 * Найденную цену отправляет в ISOLATED world через CustomEvent, оттуда —
 * в background.js, который шлёт её в Supabase.
 */

(function () {
  const POLL_INTERVAL_MS = 700;
  const MAX_WAIT_MS = 15000;

  function getProductIdFromUrl() {
    const m = location.pathname.match(/\/product\/[^/]*-(\d+)\/?$/) || location.pathname.match(/\/product\/(\d+)\/?$/);
    return m ? Number(m[1]) : null;
  }

  function priceFromDom() {
    const widget = document.querySelector('[data-widget="webPrice"]');
    const root = widget ?? document;
    const prices = [];
    for (const el of root.querySelectorAll('span')) {
      const t = el.textContent?.trim();
      if (!t || !/^\d[\d\s]*\s*₽$/.test(t)) continue;
      const digits = t.replace(/[^\d]/g, '');
      if (digits.length < 2) continue;
      const value = Number(digits);
      if (value > 0) prices.push(value);
    }
    if (prices.length === 0) return null;
    // Цена с Ozon Картой — со скидкой (ниже), обычная цена — выше.
    // Берём максимум, чтобы получить цену БЕЗ скидки по карте.
    return Math.max(...prices);
  }

  function getProductTitle() {
    const h1 = document.querySelector('h1');
    return h1?.textContent?.trim() ?? document.title;
  }

  function report(buyerPrice, source) {
    const productId = getProductIdFromUrl();
    if (!productId || !buyerPrice) return;
    window.dispatchEvent(new CustomEvent('sd-ozon-price', {
      detail: {
        productId,
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

    const domPrice = priceFromDom();
    if (domPrice) {
      clearInterval(timer);
      report(domPrice, 'dom');
      return;
    }

    if (elapsed >= MAX_WAIT_MS) {
      clearInterval(timer);
    }
  }, POLL_INTERVAL_MS);
})();
