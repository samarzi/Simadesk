/**
 * SimaDesk Extension — Background Service Worker.
 *
 * Принимает команды от:
 *   1. SimaDesk сайта (externally_connectable)
 *   2. Popup расширения
 *   3. Content scripts (логи, прогресс)
 *
 * Управляет вкладками маркетплейсов и инжектом content scripts.
 */

// ── Состояние ─────────────────────────────────────────────────────────────

const tasks = {};      // taskId → { status, type, tabId, logs[], port }
let sitePort = null;   // long-lived connection с сайтом SimaDesk

// Источники, которым разрешено слать externally_connectable-сообщения.
// Зеркалит manifest.json → externally_connectable.matches; здесь дублируем явной
// runtime-проверкой sender.origin, т.к. сама декларация в манифесте не гарантирует
// защиту от обхода (например через chrome.runtime.sendMessage с произвольным extension id).
const ALLOWED_EXTERNAL_ORIGINS = [
  'https://simadesk.ru',
];
function isAllowedExternalSender(sender) {
  const origin = sender?.origin || (sender?.url ? new URL(sender.url).origin : '');
  if (ALLOWED_EXTERNAL_ORIGINS.includes(origin)) return true;
  return /^http:\/\/localhost(:\d+)?$/.test(origin);
}

// Последние неудачные попытки собрать реальную цену покупателя — видно в popup
// вместо тихого "цена не найдена" без следа. Ограничено последними 50 записями.
const priceScanFailures = [];
function logPriceScanFailure(marketplace, info) {
  priceScanFailures.unshift({ marketplace, ...info, at: new Date().toISOString() });
  if (priceScanFailures.length > 50) priceScanFailures.length = 50;
  console.warn(`[SimaDesk] не удалось собрать цену (${marketplace}):`, info);
  broadcastToPopup({ type: 'price-scan-failure', marketplace, ...info });
}

// ── Supabase: сбор реальных цен покупателя на Yandex Market ───────────────

const API_URL = 'https://simadesk.ru';
// API_ANON_KEY загружается из chrome.storage (установка при первом запуске через SimaDesk website)
// или из fallback-константы. Supabase anon key по дизайну публичный — безопасность через RLS.
const DEFAULT_API_ANON_KEY = '';
let API_ANON_KEY = DEFAULT_API_ANON_KEY;

// Загрузка ключа из chrome.storage при старте service worker
chrome.storage.local.get(['api_anon_key'], (result) => {
  if (result.api_anon_key) API_ANON_KEY = result.api_anon_key;
});

// Обновление ключа при получении от SimaDesk website
function handleExternalConfig(message) {
  if (message?.type === 'config' && message?.api_anon_key) {
    API_ANON_KEY = message.api_anon_key;
    chrome.storage.local.set({ api_anon_key: message.api_anon_key });
  }
}
const YANDEX_PRICE_BRIDGE = `${API_URL}/functions/v1/yandex-price-bridge`;
const yandexPriceTabs = new Map(); // tabId → { marketSku, offerId, timeoutId }

// ── Supabase: сбор реальных цен покупателя на Wildberries ──────────────────

const WB_PRICE_BRIDGE = `${API_URL}/functions/v1/wb-price-bridge`;
const wbPriceTabs = new Map(); // tabId → { nmId, vendorCode, timeoutId }

// ── Supabase: сбор реальных цен покупателя на Ozon ─────────────────────────

const OZON_PRICE_BRIDGE = `${API_URL}/functions/v1/ozon-price-bridge`;
const ozonPriceTabs = new Map(); // tabId → { productId, offerId, timeoutId }

// ── Keep-alive через chrome.alarms (надёжнее setInterval в MV3) ───────────

chrome.alarms.create('sd-keepalive', { periodInMinutes: 0.4 }); // каждые ~24 сек
chrome.alarms.create('sd-yandex-price-scan', { periodInMinutes: 20, delayInMinutes: 1 });
chrome.alarms.create('sd-wb-price-scan', { periodInMinutes: 20, delayInMinutes: 2 });
chrome.alarms.create('sd-ozon-price-scan', { periodInMinutes: 20, delayInMinutes: 3 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sd-yandex-price-scan') {
    scanYandexPrices().catch(() => {});
    return;
  }
  if (alarm.name === 'sd-wb-price-scan') {
    scanWbPrices().catch(() => {});
    return;
  }
  if (alarm.name === 'sd-ozon-price-scan') {
    scanOzonPrices().catch(() => {});
    return;
  }
  if (alarm.name !== 'sd-keepalive') return;
  // Сохраняем состояние задач в session storage, чтобы пережить сон SW
  const snapshot = {};
  for (const [id, t] of Object.entries(tasks)) {
    snapshot[id] = { id: t.id, type: t.type, status: t.status, tabId: t.tabId, logs: t.logs };
  }
  chrome.storage.session.set({ sd_tasks: snapshot }).catch(() => {});
});

function startKeepAlive() {
  // Будильник уже создан глобально — ничего не нужно делать
}

// При старте SW восстанавливаем задачи из session storage (если SW перезапустился)
chrome.storage.session.get('sd_tasks').then((data) => {
  if (!data.sd_tasks) return;
  for (const [id, t] of Object.entries(data.sd_tasks)) {
    if (!tasks[id]) {
      tasks[id] = { ...t, params: t.params || {} };
    }
  }
}).catch(() => {});

// ── Генерация ID ──────────────────────────────────────────────────────────

function makeId() {
  return Math.random().toString(36).substring(2, 10);
}

// ── Логирование в задачу ──────────────────────────────────────────────────

function taskLog(taskId, line) {
  const task = tasks[taskId];
  if (!task) return;
  task.logs.push(line);
  // Отправляем лог на сайт SimaDesk
  broadcastToSite({ type: 'task-log', taskId, line, status: task.status });
  // Отправляем в popup
  broadcastToPopup({ type: 'task-log', taskId, line, status: task.status });
}

function taskStatus(taskId, status, detail) {
  const task = tasks[taskId];
  if (!task) return;
  task.status = status;
  if (detail) task.detail = detail;
  broadcastToSite({ type: 'task-status', taskId, status, detail });
  broadcastToPopup({ type: 'task-status', taskId, status, detail });
}

// ── Broadcast ─────────────────────────────────────────────────────────────

function broadcastToSite(msg) {
  if (sitePort) {
    try { sitePort.postMessage(msg); } catch { sitePort = null; }
  }
}

const popupPorts = new Set();

function broadcastToPopup(msg) {
  for (const port of popupPorts) {
    try { port.postMessage(msg); } catch { popupPorts.delete(port); }
  }
}

// ── Обработка сообщений от content scripts ────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Логи от content scripts
  if (msg.type === 'log') {
    // Найти задачу по tabId
    const tabId = sender.tab?.id;
    const task = Object.values(tasks).find(t => t.tabId === tabId);
    if (task) taskLog(task.id, msg.text);
    return;
  }

  // Активация вкладки: выбираем вкладку и выводим окно Chrome на передний план,
  // чтобы IntersectionObserver работал и таймеры не throttle-ились.
  // НО: chrome.windows.update({ focused: true }) закрывает popup — пропускаем его
  // когда popup открыт (popupPorts.size > 0). Tab.update остаётся всегда.
  if (msg.type === 'activate-tab') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.tabs.get(tabId).then(tab => {
        if (tab?.windowId && popupPorts.size === 0) {
          chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
        chrome.tabs.update(tabId, { active: true }).catch(() => {});
      }).catch(() => {});
    }
    return;
  }

  // Прогресс от content scripts
  if (msg.type === 'progress') {
    const tabId = sender.tab?.id;
    const task = Object.values(tasks).find(t => t.tabId === tabId);
    if (task) {
      task.progress = msg;
      broadcastToSite({ type: 'task-progress', taskId: task.id, ...msg });
      broadcastToPopup({ type: 'task-progress', taskId: task.id, ...msg });
    }
    return;
  }

  // Sima element picker result — forward to popup
  if (msg.type === 'sima-pick-result') {
    broadcastToPopup({ type: 'sima-pick-result', text: msg.text, tag: msg.tag });
    return;
  }

  // Fix 2: расширение сообщает о потраченных токенах → пишем в localStorage SimaDesk
  if (msg.type === 'sima-token-write') {
    const count = msg.count;
    if (count > 0) {
      const today = new Date().toISOString().slice(0, 10);
      chrome.tabs.query({ url: ['https://simadesk.ru/*', 'http://localhost:*/*'] }, (tabs) => {
        for (const tab of tabs) {
          if (tab.id != null) {
            chrome.tabs.sendMessage(tab.id, { type: 'sima-token-write', count, date: today }).catch(() => {});
          }
        }
      });
    }
    return;
  }

  // SimaDesk key + quota sync from bridge
  if (msg.type === 'sima-sync') {
    const updates = {};
    if (msg.ai_key)     updates.sima_ai_key   = msg.ai_key;
    if (msg.used_today !== undefined) updates.sima_used_today = msg.used_today;
    if (msg.boost !== undefined)      updates.sima_boost      = msg.boost;
    if (Object.keys(updates).length) {
      chrome.storage.local.set(updates);
      broadcastToPopup({ type: 'sima-sync', ...updates });
    }
    return;
  }

  // Статус от content scripts
  if (msg.type === 'status') {
    const tabId = sender.tab?.id;
    const task = Object.values(tasks).find(t => t.tabId === tabId);
    if (task) taskStatus(task.id, msg.status, msg.detail);
    return;
  }

  // Найдена цена покупателя на market.yandex.ru
  if (msg.type === 'yandex-price-found') {
    const tabId = sender.tab?.id;
    const pending = tabId != null ? yandexPriceTabs.get(tabId) : null;
    const offerId = pending?.offerId;
    reportYandexPrice({ ...msg, offerId });
    if (pending) {
      clearTimeout(pending.timeoutId);
      yandexPriceTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
      pending.resolve({ price: msg.buyerPrice ?? null });
    }
    return;
  }

  // Найдена цена покупателя на wildberries.ru
  if (msg.type === 'wb-price-found') {
    const tabId = sender.tab?.id;
    const pending = tabId != null ? wbPriceTabs.get(tabId) : null;
    const vendorCode = pending?.vendorCode;
    reportWbPrice({ ...msg, vendorCode });
    if (pending) {
      clearTimeout(pending.timeoutId);
      wbPriceTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
      pending.resolve({ price: msg.buyerPrice ?? null });
    }
    return;
  }

  // Найдена цена покупателя на ozon.ru
  if (msg.type === 'ozon-price-found') {
    const tabId = sender.tab?.id;
    const pending = tabId != null ? ozonPriceTabs.get(tabId) : null;
    const offerId = pending?.offerId;
    reportOzonPrice({ ...msg, offerId });
    if (pending) {
      clearTimeout(pending.timeoutId);
      ozonPriceTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
      pending.resolve({ price: msg.buyerPrice ?? null });
    }
    return;
  }

  // Health check от сайта / popup
  if (msg.type === 'ping') {
    sendResponse({ type: 'pong', version: '1.0.0' });
    return true;
  }

  // Неудачные попытки собрать цену покупателя (popup может показать предупреждение)
  if (msg.type === 'get-price-scan-failures') {
    sendResponse({ failures: priceScanFailures });
    return true;
  }

  // Список задач
  if (msg.type === 'get-tasks') {
    const list = Object.values(tasks).map(t => ({
      id: t.id, type: t.type, status: t.status,
      logsCount: t.logs.length,
    }));
    sendResponse({ tasks: list });
    return true;
  }

  // Получить логи задачи
  if (msg.type === 'get-logs') {
    const task = tasks[msg.taskId];
    if (!task) { sendResponse({ error: 'not found' }); return true; }
    const since = msg.since || 0;
    sendResponse({
      id: task.id,
      status: task.status,
      logs: task.logs.slice(since),
      total: task.logs.length,
    });
    return true;
  }
});

// ── Long-lived connections ────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));
    port.onMessage.addListener((msg) => handleCommand(msg, port));
    return;
  }
});

// Connections от внешних сайтов (SimaDesk)
chrome.runtime.onConnectExternal.addListener((port) => {
  if (!isAllowedExternalSender(port.sender)) {
    console.warn('[SimaDesk] заблокировано внешнее подключение от чужого origin:', port.sender?.origin || port.sender?.url);
    port.disconnect();
    return;
  }
  sitePort = port;
  port.onDisconnect.addListener(() => { sitePort = null; });
  port.onMessage.addListener((msg) => handleCommand(msg, port));
});

// Одиночные сообщения от внешних сайтов
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!isAllowedExternalSender(sender)) {
    console.warn('[SimaDesk] заблокировано внешнее сообщение от чужого origin:', sender?.origin || sender?.url);
    sendResponse({ error: 'forbidden_origin' });
    return true;
  }
  if (msg.type === 'get-price-scan-failures') {
    sendResponse({ failures: priceScanFailures });
    return true;
  }
  if (msg.type === 'ping') {
    sendResponse({ type: 'pong', version: '1.0.0' });
    return true;
  }
  if (msg.type === 'config') {
    handleExternalConfig(msg);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'scan-ozon') {
    handleScanOzon(msg).then(res => sendResponse(res));
    return true;
  }
  if (msg.type === 'scan-yandex') {
    handleScanYandex(msg).then(res => sendResponse(res));
    return true;
  }
  if (msg.type === 'check-price-now') {
    handleCheckPriceNow(msg).then(res => sendResponse(res));
    return true;
  }
  if (msg.type === 'start-task') {
    handleStartTask(msg).then(res => sendResponse(res));
    return true; // async
  }
  if (msg.type === 'stop-task') {
    handleStopTask(msg.taskId);
    sendResponse({ stopped: true });
    return true;
  }
  if (msg.type === 'pause-task') {
    handlePauseTask(msg.taskId);
    sendResponse({ paused: true });
    return true;
  }
  if (msg.type === 'resume-task') {
    handleResumeTask(msg.taskId);
    sendResponse({ resumed: true });
    return true;
  }
  if (msg.type === 'get-tasks') {
    const list = Object.values(tasks).map(t => ({
      id: t.id, type: t.type, status: t.status,
      logsCount: t.logs.length,
    }));
    sendResponse({ tasks: list });
    return true;
  }
  if (msg.type === 'get-logs') {
    const task = tasks[msg.taskId];
    if (!task) { sendResponse({ error: 'not found' }); return true; }
    sendResponse({
      id: task.id, status: task.status,
      logs: task.logs.slice(msg.since || 0),
      total: task.logs.length,
    });
    return true;
  }
});

// ── Команды ───────────────────────────────────────────────────────────────

function handleCommand(msg, port) {
  switch (msg.type) {
    case 'start-task':
      handleStartTask(msg).then(res => {
        try { port.postMessage(res); } catch {}
      });
      break;
    case 'stop-task':
      handleStopTask(msg.taskId);
      try { port.postMessage({ type: 'stopped', taskId: msg.taskId }); } catch {}
      break;
    case 'skip-zone':
      handleSkipZone(msg.taskId);
      break;
    case 'pause-task':
      handlePauseTask(msg.taskId);
      break;
    case 'resume-task':
      handleResumeTask(msg.taskId);
      break;
  }
}

// ── Сканирование складов Ozon ─────────────────────────────────────────────

async function handleScanOzon(msg) {
  const targetUrl = msg.url || 'https://seller.ozon.ru/app/warehouse';

  // Keep service worker alive during long scan
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);

  try {
    const tab = await chrome.tabs.create({ url: targetUrl, active: true });
    await waitForTabLoad(tab.id);
    await new Promise(r => setTimeout(r, 5000));

    // Wait for warehouse cards to appear (auth check)
    const authCheck = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 25; i++) {
          const cards = document.querySelectorAll('[data-widget="warehouse-card-title"]');
          if (cards.length > 0) return { ok: true, count: cards.length };
          if (window.location.href.includes('login') || window.location.href.includes('passport')) {
            return { ok: false, reason: 'not_authorized' };
          }
          await sleep(1000);
        }
        return { ok: false, reason: 'timeout' };
      },
    });

    const auth = authCheck?.[0]?.result;
    if (!auth?.ok) {
      clearInterval(keepAlive);
      return { error: auth?.reason || 'not_authorized', warehouses: [], scanTabId: tab.id };
    }

    // ONE PASS: expand + collect zones per warehouse while it's scrolled into view.
    //
    // WHY merged: Ozon lazily loads warehouses as you scroll — only 2-3 cards are in
    // the DOM on initial paint. After scrolling down new cards appear; after scrolling
    // back up they may disappear. A separate scan pass therefore misses the late-loaded
    // cards. By collecting zone data immediately after expanding each warehouse we avoid
    // this entirely.
    //
    // WHY dynamic loop: cardCount must be re-checked every iteration. If we capture it
    // once at start (= 3), we'd never visit warehouses 4-5 that load as we scroll.
    //
    // Zone detection: mirrors ozon-warehouse.js exactly — querySelectorAll on
    // '.nd4-ea6[title], div[title]' without any keyword filter so "Феникс 2025",
    // "Липецк", "Курьером" are all captured correctly.
    const scanResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        // Re-query every time — React replaces nodes, and page grows as we scroll
        const getCards = () => document.querySelectorAll('[data-widget="warehouse-card-title"]');
        const getCard  = i => getCards()[i];

        const warehouses = [];
        let i = 0;

        while (true) {
          // Re-read count — page may lazy-load more warehouses as we scroll
          const currentCount = getCards().length;

          if (i >= currentCount) {
            // We've processed everything visible so far.
            // Scroll down to provoke lazy loading of any remaining warehouses,
            // then wait and check again. Only exit if nothing new appeared.
            const lastCard = getCard(currentCount - 1);
            if (lastCard) lastCard.scrollIntoView({ block: 'end', behavior: 'smooth' });
            else window.scrollBy(0, 800);
            await sleep(2000);
            if (getCards().length > currentCount) continue; // new cards appeared — keep going
            break; // no new cards after waiting — we're done
          }

          // ── Scroll into view (triggers lazy render for this card's content) ──
          let card = getCard(i);
          if (!card) { i++; continue; }
          card.scrollIntoView({ block: 'center', behavior: 'smooth' });
          await sleep(1500);

          // ── Expand "Показать ещё" until gone ────────────────────────────────
          for (let attempt = 0; attempt < 20; attempt++) {
            card = getCard(i);
            if (!card || !card.isConnected) break;
            const liEl = card.closest('li');
            if (!liEl) break;

            let clicked = false;
            for (const btn of liEl.querySelectorAll('button')) {
              const text = btn.textContent.trim().toLowerCase();
              if (text.includes('показать ещё') || text.includes('показать еще') || text.includes('show more')) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                clicked = true;
                await sleep(2500);
                break;
              }
            }
            if (!clicked) break;
          }

          await sleep(400);

          // ── Collect zones — same selectors as ozon-warehouse.js ─────────────
          card = getCard(i);
          if (!card || !card.isConnected) { i++; continue; }

          const name  = card.textContent.trim();
          const li    = card.closest('li');
          const zones = [];
          const seen  = new Set();

          if (li) {
            // Mirror ozon-warehouse.js Strategy 2: class-based + div[title], NO regex
            // so zone names like "Феникс 2025" / "Липецк" are captured correctly.
            const zoneDivs = li.querySelectorAll('.nd4-ea6[title], [class*="ea6"][title], div[title]');
            for (const zd of zoneDivs) {
              const t = zd.getAttribute('title') || '';
              if (t && t.length > 1 && t.length < 100 && !seen.has(t)) {
                seen.add(t);
                zones.push({ name: zd.textContent.trim(), title: t });
              }
            }
          }

          warehouses.push({ name, index: i, zones, zonesCount: zones.length });
          i++;
        }

        return { warehouses };
      },
    });

    const data = scanResults?.[0]?.result || { warehouses: [] };
    data.scanTabId = tab.id;
    clearInterval(keepAlive);
    return data;

  } catch (err) {
    clearInterval(keepAlive);
    return { error: err.message, warehouses: [] };
  }
}

// ── Сканирование складов Яндекс ──────────────────────────────────────────

async function handleScanYandex(msg) {
  const targetUrl = msg.url || 'https://partner.market.yandex.ru';

  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);

  try {
    const tab = await chrome.tabs.create({ url: targetUrl, active: true });
    await waitForTabLoad(tab.id);
    await new Promise(r => setTimeout(r, 5000));

    // Wait for the warehouses table to appear
    const scanResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        // Wait for table rows to appear
        for (let i = 0; i < 30; i++) {
          const links = document.querySelectorAll('a[data-e2e="levitan-link"][href*="delivery?warehouseId="]');
          if (links.length > 0) break;
          // Check if redirected to auth
          if (window.location.href.includes('passport') || window.location.href.includes('login')) {
            return { error: 'not_authorized', warehouses: [] };
          }
          await sleep(1000);
        }

        // Scan warehouse rows
        const warehouses = [];
        const links = document.querySelectorAll('a[data-e2e="levitan-link"][href*="delivery?warehouseId="]');
        for (const link of links) {
          const name = link.textContent.trim();
          const href = link.getAttribute('href') || '';
          // Build full URL
          const fullUrl = href.startsWith('http') ? href : window.location.origin + href;

          // Try to find address in the same cell
          let address = '';
          const cell = link.closest('td') || link.closest('[data-e2e="levitan-table-cell"]');
          if (cell) {
            const spans = cell.querySelectorAll('span');
            for (const span of spans) {
              const text = span.textContent.trim();
              // Address is the longer text that's not the warehouse name
              if (text !== name && text.length > 10) {
                address = text;
                break;
              }
            }
          }

          warehouses.push({ name, url: fullUrl, address });
        }

        return { warehouses };
      },
    });

    const data = scanResults?.[0]?.result || { warehouses: [] };
    data.scanTabId = tab.id;
    clearInterval(keepAlive);
    return data;

  } catch (err) {
    clearInterval(keepAlive);
    return { error: err.message, warehouses: [] };
  }
}

// ── Сбор реальных цен покупателя на Yandex Market (через расширение) ──────

async function scanYandexPrices() {
  let targets;
  try {
    const resp = await fetch(`${YANDEX_PRICE_BRIDGE}?action=targets`, {
      headers: {
        apikey: API_ANON_KEY,
        Authorization: `Bearer ${API_ANON_KEY}`,
      },
    });
    const data = await resp.json();
    targets = data.targets || [];
  } catch {
    return;
  }

  for (const target of targets) {
    try {
      await openYandexPriceTab(target);
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
}

function openYandexPriceTab({ marketSku, marketModelId, offerId, productTitle }) {
  // product/{modelId}?sku={msku} открывает точную карточку — поиск по marketSku
  // ненадёжен (текстовый полнотекстовый поиск). Если modelId неизвестен — fallback на поиск.
  const url = marketModelId
    ? `https://market.yandex.ru/product/${marketModelId}?sku=${marketSku}`
    : `https://market.yandex.ru/search?text=${marketSku}`;
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      const timeoutId = setTimeout(() => {
        yandexPriceTabs.delete(tab.id);
        chrome.tabs.remove(tab.id).catch(() => {});
        logPriceScanFailure('yandex', { marketSku, offerId, productTitle, reason: 'timeout_or_selector_not_found' });
        resolve({ price: null });
      }, 20000);
      yandexPriceTabs.set(tab.id, { marketSku, offerId, productTitle, timeoutId, resolve });
    });
  });
}

async function reportYandexPrice(detail) {
  try {
    await fetch(YANDEX_PRICE_BRIDGE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: API_ANON_KEY,
        Authorization: `Bearer ${API_ANON_KEY}`,
      },
      body: JSON.stringify({
        action: 'report',
        marketSku: detail.marketSku,
        offerId: detail.offerId,
        buyerPrice: detail.buyerPrice,
        productTitle: detail.productTitle,
      }),
    });
  } catch {}
}

// ── Сбор реальных цен покупателя на Wildberries (через расширение) ────────

async function scanWbPrices() {
  let targets;
  try {
    const resp = await fetch(`${WB_PRICE_BRIDGE}?action=targets`, {
      headers: {
        apikey: API_ANON_KEY,
        Authorization: `Bearer ${API_ANON_KEY}`,
      },
    });
    const data = await resp.json();
    targets = data.targets || [];
  } catch {
    return;
  }

  for (const target of targets) {
    try {
      await openWbPriceTab(target);
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
}

function openWbPriceTab({ nmId, vendorCode, productTitle }) {
  return new Promise((resolve) => {
    chrome.tabs.create({
      url: `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`,
      active: false,
    }, (tab) => {
      const timeoutId = setTimeout(() => {
        wbPriceTabs.delete(tab.id);
        chrome.tabs.remove(tab.id).catch(() => {});
        logPriceScanFailure('wb', { nmId, vendorCode, productTitle, reason: 'timeout_or_selector_not_found' });
        resolve({ price: null });
      }, 20000);
      wbPriceTabs.set(tab.id, { nmId, vendorCode, productTitle, timeoutId, resolve });
    });
  });
}

async function reportWbPrice(detail) {
  try {
    await fetch(WB_PRICE_BRIDGE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: API_ANON_KEY,
        Authorization: `Bearer ${API_ANON_KEY}`,
      },
      body: JSON.stringify({
        action: 'report',
        nmId: detail.nmId,
        vendorCode: detail.vendorCode,
        buyerPrice: detail.buyerPrice,
        productTitle: detail.productTitle,
      }),
    });
  } catch {}
}

// ── Сбор реальных цен покупателя на Ozon (через расширение) ───────────────

async function scanOzonPrices() {
  let targets;
  try {
    const resp = await fetch(`${OZON_PRICE_BRIDGE}?action=targets`, {
      headers: {
        apikey: API_ANON_KEY,
        Authorization: `Bearer ${API_ANON_KEY}`,
      },
    });
    const data = await resp.json();
    targets = data.targets || [];
  } catch {
    return;
  }

  for (const target of targets) {
    try {
      await openOzonPriceTab(target);
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
}

function openOzonPriceTab({ sku, productId, offerId, productTitle }) {
  // sku — Ozon storefront SKU (правильная ссылка на карточку для покупателя);
  // productId — старый id из фонового скана (если sku не передан).
  const id = sku ?? productId;
  return new Promise((resolve) => {
    chrome.tabs.create({
      url: `https://www.ozon.ru/product/${id}/`,
      active: false,
    }, (tab) => {
      const timeoutId = setTimeout(() => {
        ozonPriceTabs.delete(tab.id);
        chrome.tabs.remove(tab.id).catch(() => {});
        logPriceScanFailure('ozon', { sku: id, offerId, productTitle, reason: 'timeout_or_selector_not_found' });
        resolve({ price: null });
      }, 20000);
      ozonPriceTabs.set(tab.id, { sku: id, offerId, productTitle, timeoutId, resolve });
    });
  });
}

async function reportOzonPrice(detail) {
  try {
    await fetch(OZON_PRICE_BRIDGE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: API_ANON_KEY,
        Authorization: `Bearer ${API_ANON_KEY}`,
      },
      body: JSON.stringify({
        action: 'report',
        productId: detail.productId,
        offerId: detail.offerId,
        buyerPrice: detail.buyerPrice,
        productTitle: detail.productTitle,
      }),
    });
  } catch {}
}

// ── Проверка точной цены по запросу (открыть карточку товара прямо сейчас) ─

async function handleCheckPriceNow(msg) {
  const { marketplace, nmId, sku, offerId, marketSku, marketModelId, vendorCode, productTitle } = msg;
  try {
    if (marketplace === 'wb') {
      if (!nmId) return { ok: false, error: 'nmId не указан' };
      const { price } = await openWbPriceTab({ nmId, vendorCode, productTitle });
      if (!price) return { ok: false, error: 'Цена не найдена на странице товара' };
      return { ok: true, price };
    }
    if (marketplace === 'ozon') {
      if (!sku) return { ok: false, error: 'sku не указан' };
      const { price } = await openOzonPriceTab({ sku, offerId, productTitle });
      if (!price) return { ok: false, error: 'Цена не найдена на странице товара' };
      return { ok: true, price };
    }
    if (marketplace === 'yandex') {
      if (!marketSku) return { ok: false, error: 'marketSku неизвестен' };
      const { price } = await openYandexPriceTab({ marketSku, marketModelId, offerId, productTitle });
      if (!price) return { ok: false, error: 'Цена не найдена на странице товара' };
      return { ok: true, price };
    }
    return { ok: false, error: 'неизвестный маркетплейс' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Запуск задачи ─────────────────────────────────────────────────────────

async function handleStartTask(msg) {
  const { scriptType, params } = msg;

  // Prevent duplicate: if a task of the same type is already running/paused, return it
  const existing = Object.values(tasks).find(
    t => t.type === scriptType && (t.status === 'running' || t.status === 'started' || t.status === 'paused')
  );
  if (existing) {
    return { taskId: existing.id, status: 'already_running' };
  }

  const taskId = makeId();

  // Определяем URL и скрипт
  let targetUrl, scriptFile;
  switch (scriptType) {
    case 'yandex-warehouses':
      targetUrl = params.warehouseUrl || 'https://partner.market.yandex.ru';
      scriptFile = 'content/yandex-warehouse.js';
      break;
    case 'yandex-tariffs':
      targetUrl = params.warehouseUrl || 'https://partner.market.yandex.ru';
      scriptFile = 'content/yandex-tariff.js';
      break;
    case 'ozon-warehouses':
      targetUrl = params.warehouseUrl || 'https://seller.ozon.ru/app/warehouse';
      scriptFile = 'content/ozon-warehouse.js';
      break;
    default:
      return { error: `Unknown script type: ${scriptType}` };
  }

  // Создаём задачу
  const task = {
    id: taskId,
    type: scriptType,
    status: 'running',
    tabId: null,
    logs: [],
    params,
    startedAt: new Date().toISOString(),
  };
  tasks[taskId] = task;
  startKeepAlive();

  taskLog(taskId, `[${time()}] → Запуск: ${scriptType}`);
  taskLog(taskId, `[${time()}] → URL: ${targetUrl}`);
  if (params.cities?.length) {
    taskLog(taskId, `[${time()}] → Городов: ${params.cities.length}`);
  }

  try {
    // Открываем вкладку
    const tab = await chrome.tabs.create({ url: targetUrl, active: true });
    task.tabId = tab.id;

    // Ждём загрузки
    await waitForTabLoad(tab.id);
    taskLog(taskId, `[${time()}] ✅ Страница загружена`);

    // Инжектим утилиты
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['lib/utils.js'],
    });

    // Load karta.json for "С картой" mode
    if (params.mode === 'С картой' && (scriptType === 'yandex-warehouses' || scriptType === 'yandex-tariffs')) {
      try {
        const kartaUrl = chrome.runtime.getURL('lib/karta.json');
        const kartaResp = await fetch(kartaUrl);
        const kartaData = await kartaResp.json();
        taskLog(taskId, `[${time()}] → Карта загружена: ${Object.keys(kartaData).length} записей`);
        // Inject karta into page MAIN world
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (kartaJson) => { window.__SD_KARTA = kartaJson; },
          args: [kartaData],
        });
      } catch (e) {
        taskLog(taskId, `[${time()}] ⚠️ Не удалось загрузить карту: ${e.message}`);
      }
    }

    // 1) ISOLATED world: слушаем события от MAIN world + передаём параметры через DOM
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (taskDataJson) => {
        // Передаём параметры в MAIN world через data-атрибут
        document.documentElement.dataset.sdTaskParams = taskDataJson;

        // Слушаем события от MAIN world и пробрасываем в background
        window.addEventListener('sd-log', (e) => {
          chrome.runtime.sendMessage({ type: 'log', text: e.detail.text });
        });
        window.addEventListener('sd-status', (e) => {
          chrome.runtime.sendMessage({ type: 'status', ...e.detail });
        });
        window.addEventListener('sd-progress', (e) => {
          chrome.runtime.sendMessage({ type: 'progress', ...e.detail });
        });
        // Активация вкладки (нужна для IntersectionObserver и корректных таймеров)
        window.addEventListener('sd-activate-tab', () => {
          chrome.runtime.sendMessage({ type: 'activate-tab' });
        });
      },
      args: [JSON.stringify({ taskId, scriptType, params })],
    });

    // 2) MAIN world: основной скрипт (читает параметры из data-атрибута)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [scriptFile],
      world: 'MAIN',
    });

    return { taskId, status: 'started' };

  } catch (err) {
    taskStatus(taskId, 'error', err.message);
    taskLog(taskId, `[${time()}] ❌ Ошибка запуска: ${err.message}`);
    return { taskId, status: 'error', error: err.message };
  }
}

// ── Пропуск текущей зоны ─────────────────────────────────────────────────

function handleSkipZone(taskId) {
  const task = tasks[taskId];
  if (!task) return;

  taskLog(taskId, `[${time()}] ⏭ Пропуск зоны по команде пользователя`);

  if (task.tabId) {
    try {
      chrome.scripting.executeScript({
        target: { tabId: task.tabId },
        world: 'MAIN',
        func: () => { window.__SD_SKIP_ZONE = true; },
      });
    } catch {}
  }
}

// ── Пауза / Продолжение задачи ────────────────────────────────────────────

function handlePauseTask(taskId) {
  const task = tasks[taskId];
  if (!task || (task.status !== 'running' && task.status !== 'started')) return;

  task.status = 'paused';
  taskLog(taskId, `[${time()}] ⏸ Пауза по команде пользователя`);

  if (task.tabId) {
    try {
      chrome.scripting.executeScript({
        target: { tabId: task.tabId },
        world: 'MAIN',
        func: () => { window.__SD_PAUSE = true; },
      });
    } catch {}
  }

  broadcastToSite({ type: 'task-status', taskId, status: 'paused' });
  broadcastToPopup({ type: 'task-status', taskId, status: 'paused' });
}

function handleResumeTask(taskId) {
  const task = tasks[taskId];
  if (!task || task.status !== 'paused') return;

  task.status = 'running';
  taskLog(taskId, `[${time()}] ▶ Продолжение по команде пользователя`);

  if (task.tabId) {
    try {
      chrome.scripting.executeScript({
        target: { tabId: task.tabId },
        world: 'MAIN',
        func: () => { window.__SD_PAUSE = false; },
      });
    } catch {}
  }

  broadcastToSite({ type: 'task-status', taskId, status: 'running' });
  broadcastToPopup({ type: 'task-status', taskId, status: 'running' });
}

// ── Остановка задачи ──────────────────────────────────────────────────────

function handleStopTask(taskId) {
  const task = tasks[taskId];
  if (!task) return;

  task.status = 'stopped';
  taskLog(taskId, `[${time()}] Остановлено пользователем`);

  // Отправляем стоп-сигнал в MAIN world (где работают скрипты)
  if (task.tabId) {
    try {
      chrome.scripting.executeScript({
        target: { tabId: task.tabId },
        world: 'MAIN',
        func: () => { window.__SD_STOP = true; },
      });
    } catch {}
  }

  broadcastToSite({ type: 'task-status', taskId, status: 'stopped' });
  broadcastToPopup({ type: 'task-status', taskId, status: 'stopped' });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function time() {
  return new Date().toLocaleTimeString('ru-RU');
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, 60000);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        // Небольшая задержка для полной инициализации DOM
        setTimeout(resolve, 2000);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Очистка при закрытии вкладки ──────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = yandexPriceTabs.get(tabId);
  if (pending) {
    clearTimeout(pending.timeoutId);
    yandexPriceTabs.delete(tabId);
    pending.resolve({ price: null });
  }

  const pendingWb = wbPriceTabs.get(tabId);
  if (pendingWb) {
    clearTimeout(pendingWb.timeoutId);
    wbPriceTabs.delete(tabId);
    pendingWb.resolve({ price: null });
  }

  const pendingOzon = ozonPriceTabs.get(tabId);
  if (pendingOzon) {
    clearTimeout(pendingOzon.timeoutId);
    ozonPriceTabs.delete(tabId);
    pendingOzon.resolve({ price: null });
  }

  const task = Object.values(tasks).find(t => t.tabId === tabId);
  if (task && (task.status === 'running' || task.status === 'paused')) {
    task.status = 'error';
    taskLog(task.id, `[${time()}] ❌ Вкладка закрыта`);
    broadcastToSite({ type: 'task-status', taskId: task.id, status: 'error', detail: 'Tab closed' });
  }
});
