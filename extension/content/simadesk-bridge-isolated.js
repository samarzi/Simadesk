/**
 * Runs in ISOLATED world — has access to chrome.runtime AND page storage.
 * 1. Passes extension ID to MAIN world via data attribute.
 * 2. Syncs SimaDesk AI key + quota data to extension chrome.storage.
 */
document.documentElement.dataset.simadeskExtId = chrome.runtime.id;

function todayKey() {
  return 'sd_ai_daily_' + new Date().toISOString().slice(0, 10);
}

function syncToExtension() {
  const key       = sessionStorage.getItem('sd_ai_key') || '';
  const usedToday = Number(localStorage.getItem(todayKey()) ?? 0);
  const boost     = localStorage.getItem('sd_ai_boost_package') || '';

  if (!key) return; // ключ ещё не загружен — ждём

  chrome.runtime.sendMessage({
    type: 'sima-sync',
    ai_key:     key,
    used_today: usedToday,
    boost:      boost,
  }).catch(() => {});
}

// Fix 2: принимаем от расширения информацию о потраченных токенах и пишем в localStorage SimaDesk
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sima-token-write' && msg.count > 0) {
    const key = 'sd_ai_daily_' + (msg.date || new Date().toISOString().slice(0, 10));
    const cur = Number(localStorage.getItem(key) ?? 0);
    localStorage.setItem(key, String(cur + msg.count));
    sendResponse({ ok: true });
  }
  return true;
});

// Sync сразу при загрузке страницы
syncToExtension();

// И снова через 2с — к тому времени SimaDesk успевает загрузить ключ из Supabase
setTimeout(syncToExtension, 2000);
setTimeout(syncToExtension, 5000);
