/**
 * SimaDesk Extension — Page Context Scraper.
 * Runs on all marketplace pages. Responds to { type: 'sima-get-context' }
 * with structured product/page data for Sima AI chat.
 */

(function () {
  function detectPageType() {
    const h = location.hostname;
    const p = location.pathname;
    if (h === 'www.ozon.ru' && /\/product\//.test(p)) return 'product-ozon';
    if (h === 'www.wildberries.ru' && /\/catalog\/.*\/detail/.test(p)) return 'product-wb';
    if (h === 'market.yandex.ru' && /\/(product|card)\//.test(p)) return 'product-yandex';
    if (h === 'seller.ozon.ru') return 'seller-ozon';
    if (h === 'partner.market.yandex.ru') return 'seller-yandex';
    if (h === 'simadesk.ru' || /localhost/.test(h)) return 'simadesk';
    return 'generic';
  }

  function parseNum(str) {
    if (!str) return null;
    const n = parseFloat(String(str).replace(/[^\d.,]/g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  }

  function textOf(sel, root) {
    return (root ?? document).querySelector(sel)?.textContent?.trim() ?? null;
  }

  function firstMatch(sels, root) {
    for (const s of sels) {
      const t = textOf(s, root);
      if (t) return t;
    }
    return null;
  }

  function breadcrumb(sels) {
    for (const s of sels) {
      const items = [...document.querySelectorAll(s)].map(el => el.textContent?.trim()).filter(Boolean);
      if (items.length > 1) return items.join(' › ');
    }
    return null;
  }

  // ── Ozon product page ────────────────────────────────────────────────────────
  function extractOzon() {
    const title = firstMatch(['[data-widget="webProductHeading"] h1', 'h1', '[class*="titleText"]']);

    // Price: use the same logic as ozon-price-main.js
    let price = null, originalPrice = null;
    const priceEls = [...document.querySelectorAll('.pdp_jb0.tsHeadline500Medium, [class*="price"],[class*="Price"]')];
    const validPrices = [];
    for (const el of priceEls) {
      const cs = window.getComputedStyle(el);
      const dec = cs.textDecorationLine || cs.textDecoration || '';
      if (dec.includes('line-through') || el.closest('del,s')) continue;
      const v = parseNum(el.textContent);
      if (v && v > 10) validPrices.push(v);
    }
    if (validPrices.length) {
      validPrices.sort((a, b) => a - b);
      price = validPrices.length > 1 ? Math.max(...validPrices.slice(0, -1)) : validPrices[0];
    }

    // Original price (strikethrough)
    for (const el of priceEls) {
      const cs = window.getComputedStyle(el);
      const dec = cs.textDecorationLine || cs.textDecoration || '';
      if ((dec.includes('line-through') || el.closest('del,s')) && parseNum(el.textContent) > 10) {
        originalPrice = parseNum(el.textContent);
        break;
      }
    }

    // Rating
    let rating = null;
    for (const el of document.querySelectorAll('[class*="rating"],[class*="Rating"]')) {
      const t = el.textContent?.trim();
      if (/^\d[.,]\d$/.test(t)) { rating = parseFloat(t.replace(',', '.')); break; }
    }

    // Reviews count
    let reviewsCount = null;
    const reviewsRe = /(\d[\d\s]*)\s*(?:отзыв|оценк|review)/i;
    for (const el of document.querySelectorAll('[class*="review"],[class*="Review"],[class*="count"],[class*="Count"]')) {
      const m = el.textContent?.match(reviewsRe);
      if (m) { reviewsCount = parseInt(m[1].replace(/\s/g, '')); break; }
    }

    // Brand
    const brand = firstMatch(['[data-widget="webBrand"] a', '[class*="brand"]', '[class*="Brand"]']);

    // Category breadcrumb
    const category = breadcrumb(['[class*="breadCrumb"] a', '[class*="breadcrumb"] a', 'nav a']);

    // Seller
    const seller = firstMatch(['[data-widget="webSeller"] a', '[class*="seller"],[class*="Seller"]']);

    // Description
    const description = firstMatch(['[data-widget="webDescription"]', '[class*="description"],[class*="Description"]']);

    // Discount
    let discount = null;
    if (price && originalPrice && originalPrice > price) {
      discount = Math.round((1 - price / originalPrice) * 100);
    } else {
      for (const el of document.querySelectorAll('[class*="discount"],[class*="Discount"],[class*="percent"],[class*="Percent"]')) {
        const m = el.textContent?.match(/(\d+)%/);
        if (m) { discount = parseInt(m[1]); break; }
      }
    }

    return { type: 'product-ozon', marketplace: 'Ozon', url: location.href, title, price, originalPrice, discount, rating, reviewsCount, brand, category, seller, description: description?.slice(0, 800) };
  }

  // ── Wildberries product page ─────────────────────────────────────────────────
  function extractWb() {
    const title = firstMatch(['.product-page__title', 'h1', '[class*="title"]']);
    const priceText = firstMatch(['.price-block__final-price', '[class*="final-price"]', '[class*="price-block"]']);
    const price = parseNum(priceText);
    const origText = firstMatch(['.price-block__original-price', '[class*="original-price"]']);
    const originalPrice = parseNum(origText);
    const brand = firstMatch(['.product-page__brand a', '.product-page__brand', '[class*="brand"]']);
    const ratingText = firstMatch(['.product-review__rating', '[class*="rating__value"]']);
    const rating = parseNum(ratingText);
    const reviewsText = firstMatch(['.product-review__count-review', '[class*="count-review"]']);
    const reviewsCount = reviewsText ? parseNum(reviewsText.replace(/[^\d]/g, '')) : null;
    const category = breadcrumb(['.breadcrumbs__item', '[class*="breadcrumb"] a']);
    const description = firstMatch(['.product-page__description', '[class*="description"]']);
    const discount = (price && originalPrice && originalPrice > price) ? Math.round((1 - price / originalPrice) * 100) : null;
    return { type: 'product-wb', marketplace: 'Wildberries', url: location.href, title, price, originalPrice, discount, rating, reviewsCount, brand, category, description: description?.slice(0, 800) };
  }

  // ── Yandex Market product page ────────────────────────────────────────────────
  function extractYandex() {
    // JSON-LD schema.org/Product is the most reliable source on YM
    let ld = null;
    try {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        const d = JSON.parse(s.textContent);
        const arr = Array.isArray(d) ? d : [d];
        const product = arr.find(x => x['@type'] === 'Product' || x['@type'] === 'ItemPage');
        if (product) { ld = product; break; }
      }
    } catch {}

    const title = ld?.name
      || firstMatch(['h1[data-auto="product-header-title"]', 'h1[data-baobab-name="title"]', 'h1'])
      || document.title.split(' — ')[0].split(' - ')[0];

    // Price: try JSON-LD offers, then data-auto, then any element with ₽ that looks like a price
    let price = null;
    if (ld?.offers?.price) {
      price = parseNum(String(ld.offers.price));
    } else {
      const priceText = firstMatch(['[data-auto="price-value"]', '[data-auto="snippet-price-current"]']);
      if (priceText) price = parseNum(priceText);
    }
    if (!price) {
      // Last resort: scan all text nodes for a number followed by ₽
      for (const el of document.querySelectorAll('span,div,p')) {
        const t = el.textContent?.trim() ?? '';
        if (/^\d[\d\s]{2,5}[₽р]/.test(t) && !el.children.length) {
          const v = parseNum(t);
          if (v && v > 100 && v < 200000) { price = v; break; }
        }
      }
    }

    const rating = parseNum(ld?.aggregateRating?.ratingValue)
      || parseNum(firstMatch(['[data-auto="rating-value"]', '[class*="Rating__value"]', '[itemprop="ratingValue"]']));

    const reviewsCount = parseNum(String(ld?.aggregateRating?.reviewCount ?? ''))
      || parseNum((firstMatch(['[data-auto="reviews-count"]', '[class*="OpinionCount"]']) ?? '').replace(/[^\d]/g, ''));

    const brand = ld?.brand?.name
      || firstMatch(['[data-auto="product-offers-brand"] a', '[itemprop="brand"]', '[class*="Brand"] a']);

    const category = ld?.category
      || breadcrumb(['[data-auto="breadcrumb"] a', 'nav[aria-label] a', '[class*="breadcrumb"] a']);

    const description = ld?.description
      || firstMatch(['[data-auto="product-full-description"]', '[data-auto="product-description"]', '[class*="Description__text"]']);

    // Grab visible specs text for extra context
    let specs = '';
    const specEl = document.querySelector('[data-auto="product-specs"]') || document.querySelector('[class*="Specifications"]');
    if (specEl) specs = specEl.textContent?.replace(/\s+/g, ' ').trim().slice(0, 500) || '';

    const originalPrice = ld?.offers?.priceSpecification?.find?.(p => p.priceType === 'https://schema.org/ListPrice')?.price ?? null;
    const discount = (price && originalPrice && originalPrice > price)
      ? Math.round((1 - price / originalPrice) * 100) : null;

    return {
      type: 'product-yandex', marketplace: 'Яндекс Маркет', url: location.href,
      title, price, originalPrice, discount, rating, reviewsCount, brand, category,
      description: ((description || '') + (specs ? '\nХарактеристики: ' + specs : '')).slice(0, 900),
    };
  }

  // ── Generic page ─────────────────────────────────────────────────────────────
  function extractGeneric(pageType) {
    const title = document.title || textOf('h1');
    // Grab first 1000 chars of visible body text (rough)
    let bodyText = '';
    try {
      const clone = document.body.cloneNode(true);
      for (const el of clone.querySelectorAll('script,style,nav,header,footer,[role="navigation"]')) el.remove();
      bodyText = clone.textContent?.replace(/\s+/g, ' ').trim().slice(0, 1200) ?? '';
    } catch {}
    return { type: pageType, url: location.href, title, bodyText };
  }

  // ── Element Picker (Cursor-style) ────────────────────────────────────────────
  let pickActive = false;
  let pickOverlay = null;
  let lastHighlighted = null;

  const PICK_SKIP = new Set(['HTML','BODY','HEAD','SCRIPT','STYLE','NOSCRIPT']);

  function startPickMode() {
    if (pickActive) return;
    pickActive = true;

    // Translucent overlay that catches all pointer events
    pickOverlay = document.createElement('div');
    Object.assign(pickOverlay.style, {
      position: 'fixed', inset: '0',
      zIndex: '2147483646',
      cursor: 'crosshair',
      pointerEvents: 'all',
    });
    document.documentElement.appendChild(pickOverlay);

    // Highlight box
    const hl = document.createElement('div');
    hl.id = '__sima_hl';
    Object.assign(hl.style, {
      position: 'fixed', zIndex: '2147483647',
      border: '2px solid #6366f1',
      background: 'rgba(99,102,241,0.08)',
      borderRadius: '4px',
      pointerEvents: 'none',
      transition: 'all 0.08s ease',
      display: 'none',
    });
    document.documentElement.appendChild(hl);

    function onMove(e) {
      pickOverlay.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      pickOverlay.style.pointerEvents = 'all';
      if (!el || PICK_SKIP.has(el.tagName)) { hl.style.display = 'none'; return; }
      lastHighlighted = el;
      const r = el.getBoundingClientRect();
      Object.assign(hl.style, {
        display: '',
        top:    r.top    + 'px',
        left:   r.left   + 'px',
        width:  r.width  + 'px',
        height: r.height + 'px',
      });
    }

    function onClick(e) {
      e.preventDefault(); e.stopPropagation();
      const el = lastHighlighted;
      stopPickMode();
      if (!el) return;
      const text = (el.innerText || el.textContent || el.value || el.alt || '').trim().slice(0, 800);
      const tag  = el.tagName.toLowerCase();
      chrome.runtime.sendMessage({ type: 'sima-pick-result', text, tag });
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); stopPickMode(); }
    }

    pickOverlay.addEventListener('mousemove', onMove);
    pickOverlay.addEventListener('click', onClick, { once: true });
    document.addEventListener('keydown', onKey, { capture: true, once: true });
    pickOverlay._cleanup = () => {
      pickOverlay.removeEventListener('mousemove', onMove);
      document.removeEventListener('keydown', onKey, { capture: true });
    };
  }

  function stopPickMode() {
    if (!pickActive) return;
    pickActive = false;
    pickOverlay?._cleanup?.();
    pickOverlay?.remove();
    pickOverlay = null;
    lastHighlighted = null;
    document.getElementById('__sima_hl')?.remove();
  }

  // ── Main message listener ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'sima-pick-start') {
      startPickMode();
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === 'sima-pick-cancel') {
      stopPickMode();
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type !== 'sima-get-context') return;
    try {
      const pageType = detectPageType();
      let ctx;
      if (pageType === 'product-ozon') ctx = extractOzon();
      else if (pageType === 'product-wb') ctx = extractWb();
      else if (pageType === 'product-yandex') ctx = extractYandex();
      else ctx = extractGeneric(pageType);
      sendResponse(ctx);
    } catch (e) {
      sendResponse({ type: 'generic', url: location.href, title: document.title, error: String(e) });
    }
    return true;
  });
})();
