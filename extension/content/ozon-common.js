/**
 * Ozon Seller — общий content script.
 * Загружается на seller.ozon.ru автоматически.
 * Ждёт команды от background worker.
 */
(() => {
  if (window.__SD_OZ_COMMON) return;
  window.__SD_OZ_COMMON = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'stop') {
      window.__SD_STOP = true;
      sendResponse({ ok: true });
    }
  });
})();
