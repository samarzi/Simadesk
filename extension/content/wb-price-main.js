/**
 * SimaDesk — сбор реальной цены покупателя на Wildberries (MAIN world).
 *
 * Запускается на страницах товара (www.wildberries.ru/catalog/{nmId}/detail.aspx).
 * Цена с учётом СПП (скидки постоянного покупателя) видна только в настоящем
 * браузере после полной загрузки JS — поэтому это работает только как
 * content script, а не как серверный запрос.
 *
 * Найденную цену отправляет в ISOLATED world через CustomEvent, оттуда —
 * в background.js, который шлёт её в Supabase.
 */

(function () {
  const POLL_INTERVAL_MS = 700;
  const MAX_WAIT_MS = 15000;

  function getNmIdFromUrl() {
    const m = location.pathname.match(/\/catalog\/(\d+)\/detail\.aspx/);
    return m ? Number(m[1]) : null;
  }

  function priceFromDom() {
    const selectors = [
      '[class*="priceBlockFinalPrice"]',
      '[class*="priceBlockWalletPrice"]',
      'ins[class*="price"]',
      '.price-block__final-price',
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
    const nmId = getNmIdFromUrl();
    if (!nmId || !buyerPrice) return;
    window.dispatchEvent(new CustomEvent('sd-wb-price', {
      detail: {
        nmId,
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
