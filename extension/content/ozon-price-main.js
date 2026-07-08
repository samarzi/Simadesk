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

  function parsePrice(el) {
    const t = el.textContent?.trim();
    if (!t || !/^\d[\d\s]*\s*₽$/.test(t)) return 0;
    const v = Number(t.replace(/[^\d]/g, ''));
    return v > 0 ? v : 0;
  }

  function isStrikethrough(el) {
    if (el.closest('del, s')) return true;
    if ((el.getAttribute('style') ?? '').includes('line-through')) return true;
    try {
      const cs = window.getComputedStyle(el);
      const dec = cs.textDecorationLine || cs.textDecoration || '';
      if (dec.includes('line-through')) return true;
    } catch {}
    return false;
  }

  function priceFromDom() {
    // Конкретный класс основной цены на Ozon (подтверждён пользователем).
    // Берём ВСЕ совпадения, фильтруем зачёркнутые и берём минимум:
    // - если есть зачёркнутая «старая» цена с тем же классом — она выше текущей,
    //   минимум даст текущую цену (не зачёркнутую).
    // - если есть цена без карты + с Ozon Картой — обе не зачёркнуты, берём максимум
    //   из двух (цена без карты выше). Для этого случая делаем Math.max из минимального
    //   набора (убираем только явно зачёркнутые).
    const specific = document.querySelectorAll('.pdp_jb0.tsHeadline500Medium');
    const validPrices = [];
    for (const el of specific) {
      if (isStrikethrough(el)) continue;
      const v = parsePrice(el);
      if (v > 0) validPrices.push(v);
    }

    if (validPrices.length > 0) {
      if (validPrices.length === 1) return validPrices[0];
      // Несколько цен: сортируем по возрастанию.
      // Самая высокая — вероятно зачёркнутая «старая» цена, которую не поймал
      // CSS-фильтр. Убираем её и берём максимум из оставшихся
      // (обычная цена > цена с Ozon Картой).
      validPrices.sort((a, b) => a - b);
      const withoutHighest = validPrices.slice(0, -1);
      return Math.max(...withoutHighest);
    }

    // Fallback: webPrice-виджет, фильтруем зачёркнутые, берём максимум из
    // не-зачёркнутых (регулярная цена > цена Ozon Карты).
    const widget = document.querySelector('[data-widget="webPrice"]');
    const root = widget ?? document;
    const prices = [];
    for (const el of root.querySelectorAll('span')) {
      if (isStrikethrough(el)) continue;
      const v = parsePrice(el);
      if (v > 0) prices.push(v);
    }
    if (prices.length === 0) return null;
    if (prices.length === 1) return prices[0];
    // Убираем самую высокую (возможная незафиксированная зачёркнутая), берём максимум из остальных
    prices.sort((a, b) => a - b);
    return Math.max(...prices.slice(0, -1));
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
