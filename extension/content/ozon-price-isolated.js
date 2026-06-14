/**
 * SimaDesk — релей события sd-ozon-price из MAIN world в background.js.
 */

window.addEventListener('sd-ozon-price', (e) => {
  chrome.runtime.sendMessage({ type: 'ozon-price-found', ...e.detail });
});
