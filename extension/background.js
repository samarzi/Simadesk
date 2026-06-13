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

// ── Supabase: сбор реальных цен покупателя на Yandex Market ───────────────

const SUPA_URL = 'https://rdqwzojrsmbdxiczqjci.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkcXd6b2pyc21iZHhpY3pxamNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0OTAwNjEsImV4cCI6MjA5MzA2NjA2MX0.lw9aXynPfMo0hy6J_E3BBlqd6W4MTIVM3BrVdjkBaNE';
const YANDEX_PRICE_BRIDGE = `${SUPA_URL}/functions/v1/yandex-price-bridge`;
const yandexPriceTabs = new Map(); // tabId → { marketSku, offerId, timeoutId }

// ── Keep-alive через chrome.alarms (надёжнее setInterval в MV3) ───────────

chrome.alarms.create('sd-keepalive', { periodInMinutes: 0.4 }); // каждые ~24 сек
chrome.alarms.create('sd-yandex-price-scan', { periodInMinutes: 20, delayInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sd-yandex-price-scan') {
    scanYandexPrices().catch(() => {});
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
      pending.resolve();
    }
    return;
  }

  // Health check от сайта / popup
  if (msg.type === 'ping') {
    sendResponse({ type: 'pong', version: '1.0.0' });
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
  sitePort = port;
  port.onDisconnect.addListener(() => { sitePort = null; });
  port.onMessage.addListener((msg) => handleCommand(msg, port));
});

// Одиночные сообщения от внешних сайтов
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({ type: 'pong', version: '1.0.0' });
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
        apikey: SUPA_ANON_KEY,
        Authorization: `Bearer ${SUPA_ANON_KEY}`,
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

function openYandexPriceTab({ marketSku, offerId, productTitle }) {
  return new Promise((resolve) => {
    chrome.tabs.create({
      url: `https://market.yandex.ru/product/${marketSku}`,
      active: false,
    }, (tab) => {
      const timeoutId = setTimeout(() => {
        yandexPriceTabs.delete(tab.id);
        chrome.tabs.remove(tab.id).catch(() => {});
        resolve();
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
        apikey: SUPA_ANON_KEY,
        Authorization: `Bearer ${SUPA_ANON_KEY}`,
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
    pending.resolve();
  }

  const task = Object.values(tasks).find(t => t.tabId === tabId);
  if (task && (task.status === 'running' || task.status === 'paused')) {
    task.status = 'error';
    taskLog(task.id, `[${time()}] ❌ Вкладка закрыта`);
    broadcastToSite({ type: 'task-status', taskId: task.id, status: 'error', detail: 'Tab closed' });
  }
});
