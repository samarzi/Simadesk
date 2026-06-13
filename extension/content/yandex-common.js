/**
 * Yandex Market — общий content script.
 * Загружается на partner.market.yandex.ru автоматически.
 * Ждёт команды от background worker.
 */
(() => {
  if (window.__SD_YA_COMMON) return;
  window.__SD_YA_COMMON = true;

  // Слушаем команды от background
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'stop') {
      window.__SD_STOP = true;
      sendResponse({ ok: true });
    }
  });
})();
