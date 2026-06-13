/**
 * SimaDesk — релей события sd-yandex-price из MAIN world в background.js.
 */

window.addEventListener('sd-yandex-price', (e) => {
  chrome.runtime.sendMessage({ type: 'yandex-price-found', ...e.detail });
});
