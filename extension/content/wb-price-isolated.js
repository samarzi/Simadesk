/**
 * SimaDesk — релей события sd-wb-price из MAIN world в background.js.
 */

window.addEventListener('sd-wb-price', (e) => {
  chrome.runtime.sendMessage({ type: 'wb-price-found', ...e.detail });
});
