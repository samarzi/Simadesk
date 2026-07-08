/**
 * SimaDesk — сбор реальной цены покупателя на Wildberries (MAIN world).
 *
 * WB показывает цену с WB Кошельком (ниже) и цену без кошелька (выше).
 * Нам нужна цена БЕЗ кошелька — она же отображается в попапе «Детализация цены»
 * в блоке finalPriceWrap, а на странице — в строке «613 ₽ с 22% НДС для бизнеса».
 *
 * Стратегии (в порядке надёжности):
 *   1. Попап уже открыт → читаем finalPriceWrap h2
 *   2. Значок кошелька «для бизнеса» на странице → «613 ₽ с 22% НДС для бизнеса»
 *   3. Текст «без WB Кошелька» (попап) → ищем ближайшую цену
 *   4. Кликаем кнопку-кошелёк → ждём попап → читаем finalPriceWrap h2
 *   5. Общий DOM-скан (fallback, берём максимум нескрытых незачёркнутых цен)
 */

(function () {
  const POLL_INTERVAL_MS = 600;
  const MAX_WAIT_MS = 15000;

  function getNmIdFromUrl() {
    const m = location.pathname.match(/\/catalog\/(\d+)\/detail\.aspx/);
    return m ? Number(m[1]) : null;
  }

  function isStrikethrough(el) {
    if (el.closest('del, s')) return true;
    const cls = el.className ?? '';
    if (typeof cls === 'string' && (cls.includes('strikethrough') || cls.includes('OldPrice'))) return true;
    if ((el.getAttribute('style') ?? '').includes('line-through')) return true;
    try {
      const cs = window.getComputedStyle(el);
      if ((cs.textDecorationLine || cs.textDecoration || '').includes('line-through')) return true;
    } catch {}
    return false;
  }

  function parseRublePrice(el) {
    const t = el.textContent?.trim() ?? '';
    if (!/\d/.test(t)) return 0;
    if (!/[₽р]/.test(t) && !/руб/.test(t)) return 0;
    const numGroups = t.match(/\d[\d\s]*/g);
    if (numGroups && numGroups.length > 1 && t.length > 20) return 0;
    const v = Number(t.replace(/[^\d]/g, ''));
    return v > 50 && v < 10_000_000 ? v : 0;
  }

  /**
   * Стратегия 1: попап «Детализация цены» уже открыт — читаем finalPriceWrap h2.
   * finalPriceWrap = цена «без WB Кошелька» (та что нам нужна).
   */
  function priceFromOpenPopup() {
    const finalWrap = document.querySelector('[class*="finalPriceWrap"]');
    if (!finalWrap) return null;
    // Убеждаемся что попап реально отображён (не скрыт)
    if (finalWrap.closest('[style*="display: none"], [style*="display:none"]')) return null;
    const h2 = finalWrap.querySelector('h2');
    if (!h2) return null;
    const v = Number((h2.textContent ?? '').replace(/\D/g, ''));
    return v > 50 && v < 10_000_000 ? v : null;
  }

  /**
   * Стратегия 2: строка «613 ₽ с 22% НДС для бизнеса» видна без клика.
   * Первое число в этом тексте = цена без WB Кошелька.
   */
  function priceFromBusinessBadge() {
    for (const el of document.querySelectorAll('span, div')) {
      if (el.children.length > 0) continue;
      const t = el.textContent?.trim() ?? '';
      if (!/НДС.{0,20}бизнес/i.test(t)) continue;
      const m = t.match(/^(\d[\d\s]*)/);
      if (!m) continue;
      const v = Number(m[1].replace(/\D/g, ''));
      if (v > 50 && v < 10_000_000) return v;
    }
    return null;
  }

  /**
   * Стратегия 3: подпись «без WB Кошелька» рядом с ценой в уже открытом попапе.
   */
  function priceWithoutWallet() {
    for (const el of document.querySelectorAll('span, div, p')) {
      if (el.children.length > 0) continue;
      const t = el.textContent?.trim() ?? '';
      if (!/без\s+wb\s*кошельк/i.test(t) && !/без\s+кошельк/i.test(t)) continue;
      const container = el.closest('[class*="price"]')?.parentElement
        ?? el.parentElement?.parentElement
        ?? el.parentElement;
      if (!container) continue;
      for (const candidate of container.querySelectorAll('span, div, ins, h2')) {
        if (candidate === el || candidate.children.length > 0) continue;
        if (isStrikethrough(candidate)) continue;
        const v = parseRublePrice(candidate);
        if (v > 0) return v;
      }
    }
    return null;
  }

  /**
   * Стратегия 4 (async): кликаем по кнопке-кошельку → ждём попап → читаем finalPriceWrap.
   */
  function priceByClickingWallet() {
    return new Promise(resolve => {
      // Ищем кнопку кошелька (priceBlockWalletPricePointer)
      const btn = document.querySelector('[class*="priceBlockWalletPricePointer"]')
               ?? document.querySelector('[class*="priceBlockWalletPrice"]');
      if (!btn) { resolve(null); return; }

      btn.click();

      let waited = 0;
      const check = setInterval(() => {
        waited += 200;

        // Попап появился?
        const v = priceFromOpenPopup() ?? priceWithoutWallet();
        if (v) {
          clearInterval(check);
          // Закрываем попап клавишей Escape
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
   * Стратегия 5 (fallback): собираем все незачёркнутые цены, берём максимум
   * из оставшихся без самого большого (которое обычно — незачёркнутый дубль старой цены).
   */
  function priceFromDomFallback() {
    const candidates = [];
    for (const el of document.querySelectorAll('span, ins, div, p, h2')) {
      if (el.children.length > 0) continue;
      if (isStrikethrough(el)) continue;
      const v = parseRublePrice(el);
      if (v > 0) candidates.push(v);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a - b);
    const pool = candidates.length > 2 ? candidates.slice(0, -1) : candidates;
    return Math.max(...pool);
  }

  /** Синхронный проход по всем стратегиям без клика. */
  function priceFromDom() {
    return priceFromOpenPopup()
        ?? priceFromBusinessBadge()
        ?? priceWithoutWallet()
        ?? priceFromDomFallback();
  }

  function getProductTitle() {
    const h1 = document.querySelector('h1');
    return h1?.textContent?.trim() ?? document.title;
  }

  function report(buyerPrice, source) {
    const nmId = getNmIdFromUrl();
    if (!nmId || !buyerPrice) return;
    window.dispatchEvent(new CustomEvent('sd-wb-price', {
      detail: { nmId, buyerPrice, productTitle: getProductTitle(), source, url: location.href },
    }));
  }

  let elapsed = 0;
  let clickAttempted = false;
  let done = false;

  const timer = setInterval(async () => {
    if (done) return;
    elapsed += POLL_INTERVAL_MS;

    const domPrice = priceFromDom();
    if (domPrice) {
      done = true;
      clearInterval(timer);
      report(domPrice, 'dom');
      return;
    }

    // После 3 сек без результата — пробуем кликнуть кошелёк
    if (!clickAttempted && elapsed >= 3000) {
      clickAttempted = true;
      const clickPrice = await priceByClickingWallet();
      if (clickPrice && !done) {
        done = true;
        clearInterval(timer);
        report(clickPrice, 'wallet-click');
      }
      return;
    }

    if (elapsed >= MAX_WAIT_MS) clearInterval(timer);
  }, POLL_INTERVAL_MS);
})();
