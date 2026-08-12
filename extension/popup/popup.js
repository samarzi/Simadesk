/**
 * SimaDesk Extension — Popup (redesigned)
 * Two tabs: Сима AI chat + unified Terminal
 */

// ══════════════════════════════════════════════════════════
// PORT / BACKGROUND CONNECTION
// ══════════════════════════════════════════════════════════

let port = null;
let tasksReady = false;
const pendingMessages = [];

function connectPort() {
  port = chrome.runtime.connect({ name: 'popup' });
  port.onDisconnect.addListener(() => { port = null; });
  port.onMessage.addListener((msg) => {
    if (!tasksReady) { pendingMessages.push(msg); }
    else { onPortMessage(msg); }
  });
}

// ══════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════

const tasksByType = {};
const TYPE_LABELS = {
  'yandex-warehouses': 'ЯМ',
  'yandex-tariffs':    'ЯМТ',
  'ozon-warehouses':   'OZN',
};
const statusLabels = {
  idle: 'Ожидание',
  running: '▶ Выполняется',
  paused: '⏸ Пауза',
  completed: '✅ Завершено',
  error: '❌ Ошибка',
  stopped: '⏹ Остановлено',
};

// All logs in one flat array: { type, line, classified }
const allLogs = [];
let activeFilter = 'all';
let activeTaskType = null; // which type is currently running (for controls)

// ══════════════════════════════════════════════════════════
// TAB SWITCHING
// ══════════════════════════════════════════════════════════

const gfooter = document.getElementById('gfooter');

document.querySelectorAll('.tab-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-pill').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = document.querySelector(`[data-panel="${btn.dataset.tab}"]`);
    if (panel) panel.classList.add('active');
    // Sima has its own footer input — hide global footer
    const isSima = btn.dataset.tab === 'sima';
    if (gfooter) gfooter.style.display = isSima ? 'none' : '';
    if (isSima && simaApiKey) loadPageContext();
  });
});

// Hide global footer on start (Sima is default)
if (gfooter) gfooter.style.display = 'none';

// ══════════════════════════════════════════════════════════
// TERMINAL — UNIFIED LOG
// ══════════════════════════════════════════════════════════

function classifyLine(line) {
  const t = line.replace(/^\[[\d:]+\]\s*/, '');
  if (t.includes('❌')) return 'err';
  if (t.startsWith('✅') || t.startsWith('🏁') || t.startsWith('🚀')) return 'success';
  if (t.startsWith('⚠') || t.startsWith('↩')) return 'warn';
  if (t.startsWith('│') || t.startsWith('┌') || t.startsWith('└') || t.startsWith('├') ||
      t.startsWith('💾') || t.startsWith('→') || t.startsWith('   ↳') ||
      (t.startsWith('[') && t.includes('█'))) return 'info';
  return 'default';
}

function appendLog(type, line) {
  const cls = classifyLine(line);
  allLogs.push({ type, line, cls });

  const term = document.getElementById('terminal-combined');
  if (!term) return;

  // Remove empty state on first log
  const empty = term.querySelector('.empty-st');
  if (empty) empty.remove();

  if (activeFilter !== 'all' && activeFilter !== type) return;

  renderLogLine(term, type, line, cls);
}

function renderLogLine(container, type, line, cls) {
  const row = document.createElement('div');
  row.className = `tline ${cls}`;

  const tag = document.createElement('span');
  tag.className = 'ttag';
  tag.textContent = TYPE_LABELS[type] || type;

  const txt = document.createElement('span');
  txt.className = 'ttxt';
  txt.textContent = line;

  row.appendChild(tag);
  row.appendChild(txt);
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

// Filter tabs
document.querySelectorAll('.ftab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ftab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    rebuildTerminal();
  });
});

function rebuildTerminal() {
  const term = document.getElementById('terminal-combined');
  if (!term) return;
  term.innerHTML = '';

  const filtered = activeFilter === 'all'
    ? allLogs
    : allLogs.filter(e => e.type === activeFilter);

  if (filtered.length === 0) {
    term.innerHTML = '<div class="empty-st"><div class="empty-st-icon">⚡</div>Запустите автоматизацию<br>на сайте SimaDesk</div>';
    return;
  }
  for (const e of filtered) renderLogLine(term, e.type, e.line, e.cls);
}

// ══════════════════════════════════════════════════════════
// STATUS DOTS
// ══════════════════════════════════════════════════════════

function updateDot(type, status) {
  const dot = document.getElementById(`dot-${type}`);
  if (!dot) return;
  dot.className = `dot ${status}`;
}

function updateControls() {
  // Find currently active task
  const running = Object.values(tasksByType).find(t => t.status === 'running' || t.status === 'paused');
  activeTaskType = running?.type || null;

  const stopBtn  = document.getElementById('stop-active');
  const pauseBtn = document.getElementById('pause-active');
  const skipBtn  = document.getElementById('skip-ozon');

  const active = !!running;
  stopBtn?.classList.toggle('vis', active);
  pauseBtn?.classList.toggle('vis', active);

  if (pauseBtn && running) {
    pauseBtn.textContent = running.status === 'paused' ? '▶ Продолжить' : '⏸ Пауза';
  }

  // Skip only for ozon while active
  const ozon = tasksByType['ozon-warehouses'];
  const ozonActive = ozon && (ozon.status === 'running' || ozon.status === 'paused');
  skipBtn?.classList.toggle('vis', !!ozonActive);
}

function sendCmd(msgType, type) {
  const task = tasksByType[type];
  if (!task?.id) return;
  if (!port) connectPort();
  try { port.postMessage({ type: msgType, taskId: task.id }); }
  catch { connectPort(); port.postMessage({ type: msgType, taskId: task.id }); }
}

document.getElementById('stop-active')?.addEventListener('click', () => {
  if (activeTaskType) {
    sendCmd('stop-task', activeTaskType);
    appendLog(activeTaskType, `[${new Date().toLocaleTimeString('ru-RU')}] ⏹ Команда остановки отправлена`);
  }
});

document.getElementById('pause-active')?.addEventListener('click', () => {
  if (activeTaskType) {
    const task = tasksByType[activeTaskType];
    const isPaused = task?.status === 'paused';
    sendCmd(isPaused ? 'resume-task' : 'pause-task', activeTaskType);
    appendLog(activeTaskType, `[${new Date().toLocaleTimeString('ru-RU')}] ${isPaused ? '▶ Продолжение' : '⏸ Пауза'} — команда отправлена`);
  }
});

document.getElementById('skip-ozon')?.addEventListener('click', () => {
  sendCmd('skip-zone', 'ozon-warehouses');
  appendLog('ozon-warehouses', `[${new Date().toLocaleTimeString('ru-RU')}] ⏭ Пропуск зоны`);
});

document.getElementById('copy-all')?.addEventListener('click', () => {
  const btn = document.getElementById('copy-all');
  const src = activeFilter === 'all' ? allLogs : allLogs.filter(e => e.type === activeFilter);
  if (!src.length) return;
  navigator.clipboard.writeText(src.map(e => `[${TYPE_LABELS[e.type]}] ${e.line}`).join('\n')).then(() => {
    btn.textContent = 'Скопировано!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Копировать'; btn.classList.remove('copied'); }, 2000);
  });
});

// ══════════════════════════════════════════════════════════
// PORT MESSAGES
// ══════════════════════════════════════════════════════════

function onPortMessage(msg) {
  if (msg.type === 'task-log') {
    const task = Object.values(tasksByType).find(t => t.id === msg.taskId);
    if (task) appendLog(task.type, msg.line);
  }

  if (msg.type === 'task-status') {
    const task = Object.values(tasksByType).find(t => t.id === msg.taskId);
    if (task) {
      task.status = msg.status;
      updateDot(task.type, msg.status);
    }
    // Refresh all from bg to get latest state
    chrome.runtime.sendMessage({ type: 'get-tasks' }, (res) => {
      for (const t of res?.tasks || []) {
        tasksByType[t.type] = t;
        updateDot(t.type, t.status);
      }
      updateControls();
    });
  }

  if (msg.type === 'task-progress') {
    const task = Object.values(tasksByType).find(t => t.id === msg.taskId);
    if (task) {
      const pct = msg.total > 0 ? Math.round((msg.done / msg.total) * 100) : 0;
      const fill = document.getElementById('prog-fill');
      if (fill) fill.style.width = `${pct}%`;
    }
  }

  // Picker result from content script → background → popup
  if (msg.type === 'sima-pick-result') {
    onPickResult(msg);
  }

  // Key/quota sync from SimaDesk page
  if (msg.type === 'sima-sync') {
    if (msg.sima_ai_key && msg.sima_ai_key !== simaApiKey) {
      simaApiKey = msg.sima_ai_key;
      showChat();
    }
    if (msg.sima_used_today !== undefined) {
      simaUsedToday = Math.max(simaUsedToday, msg.sima_used_today);
    }
    if (msg.sima_boost !== undefined) simaBoost = msg.sima_boost;
    updateQuotaBar();
  }
}

// ══════════════════════════════════════════════════════════
// INIT TASKS + LOGS
// ══════════════════════════════════════════════════════════

connectPort();

chrome.runtime.sendMessage({ type: 'get-tasks' }, (res) => {
  const taskList = res?.tasks || [];
  for (const t of taskList) {
    tasksByType[t.type] = t;
    updateDot(t.type, t.status);
  }
  updateControls();

  let pending = taskList.length;
  if (pending === 0) {
    tasksReady = true;
    pendingMessages.splice(0).forEach(onPortMessage);
    return;
  }
  for (const t of taskList) {
    chrome.runtime.sendMessage({ type: 'get-logs', taskId: t.id, since: 0 }, (logRes) => {
      for (const line of logRes?.logs || []) appendLog(t.type, line);
      pending--;
      if (pending === 0) {
        tasksReady = true;
        pendingMessages.splice(0).forEach(onPortMessage);
      }
    });
  }
});

// ══════════════════════════════════════════════════════════
// SIMA AI CHAT
// ══════════════════════════════════════════════════════════

const SIMA_MODEL     = 'anthropic/claude-haiku-4-5';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FREE_DAILY_TOKENS = 50_000;
const BOOST_LIMITS = { ai_x5: 250_000, ai_x10: 500_000, ai_x20: 1_000_000 };

let simaHistory   = [];
let simaPageCtx   = null;
let simaApiKey    = '';
let simaLoading   = false;
let pickModeOn    = false;
let pickTabId     = null;
let simaUsedToday = 0;
let simaBoost     = '';

function getDailyLimit() {
  return BOOST_LIMITS[simaBoost] ?? FREE_DAILY_TOKENS;
}
function getDailyRemaining() {
  return Math.max(0, getDailyLimit() - simaUsedToday);
}
function recordTokens(count) {
  if (count <= 0) return;
  simaUsedToday += count;
  chrome.storage.local.set({ sima_used_today: simaUsedToday });
  updateQuotaBar();
  // Синхронизируем расход токенов обратно в SimaDesk (Fix 2: двусторонняя синхронизация)
  chrome.runtime.sendMessage({ type: 'sima-token-write', count }).catch(() => {});
}
function updateQuotaBar() {
  const bar = document.getElementById('sima-quota-bar');
  const lbl = document.getElementById('sima-quota-lbl');
  if (!bar || !lbl) return;
  const limit = getDailyLimit();
  const pct   = Math.min(100, Math.round((simaUsedToday / limit) * 100));
  const usedK = Math.round(simaUsedToday / 1000);
  const limK  = Math.round(limit / 1000);
  bar.style.width = pct + '%';
  bar.className   = 'sq-fill' + (pct >= 90 ? ' crit' : pct >= 60 ? ' warn' : '');
  lbl.textContent = `${usedK}К / ${limK}К токенов`;
}

// ── Page context ──────────────────────────────────────────
async function loadPageContext() {
  const ctxLabel = document.getElementById('sima-ctx-label');
  const ctxBadge = document.getElementById('sima-ctx-mp');
  const ctxDot   = document.getElementById('sima-ctx-dot');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    pickTabId = tab.id;

    let ctx;
    try {
      ctx = await chrome.tabs.sendMessage(tab.id, { type: 'sima-get-context' });
    } catch {
      ctx = { type: 'generic', url: tab.url, title: tab.title };
    }
    simaPageCtx = ctx;

    const mpNames = {
      'product-ozon':   'Ozon',
      'product-wb':     'WB',
      'product-yandex': 'ЯМ',
      'seller-ozon':    'Кб.Ozon',
      'seller-yandex':  'Кб.ЯМ',
      'simadesk':       'SimaDesk',
    };
    const mp = mpNames[ctx.type];

    ctxLabel.textContent = (ctx.title && ctx.type !== 'generic')
      ? ctx.title.slice(0, 52)
      : (tab.title?.slice(0, 52) || tab.url);

    if (mp) {
      ctxBadge.textContent = mp;
      ctxBadge.style.display = '';
      ctxDot.classList.add('live');
    } else {
      ctxBadge.style.display = 'none';
      ctxDot.classList.remove('live');
    }

    updateHints(ctx.type);
  } catch {
    if (ctxLabel) ctxLabel.textContent = 'Нет доступа к странице';
  }
}

function updateHints(pageType) {
  const grid = document.getElementById('hints-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const sets = {
    product: [
      ['💡', 'Плюсы и минусы продавать этот товар на маркетплейсе'],
      ['💰', 'Какая средняя цена? Стоит ли снизить чтобы продавать лучше?'],
      ['📊', 'Высокая ли конкуренция в этой нише? Стоит ли заходить?'],
    ],
    seller: [
      ['🔧', 'Что мне сейчас стоит сделать в кабинете продавца?'],
      ['📈', 'Как улучшить мои продажи на маркетплейсе?'],
      ['🎁', 'Какие акции сейчас стоит подключить?'],
    ],
    generic: [
      ['✨', 'Что ты умеешь?'],
      ['🔍', 'Как найти прибыльную нишу для маркетплейса?'],
      ['📐', 'Расскажи про юнит-экономику для маркетплейсов'],
    ],
  };

  const isProduct = ['product-ozon','product-wb','product-yandex'].includes(pageType);
  const isSeller  = ['seller-ozon','seller-yandex'].includes(pageType);
  const hints = isProduct ? sets.product : isSeller ? sets.seller : sets.generic;

  for (const [icon, text] of hints) {
    const el = document.createElement('div');
    el.className = 'hint';
    el.dataset.hint = text;
    el.textContent = `${icon} ${text}`;
    el.addEventListener('click', () => sendSimaMessage(text));
    grid.appendChild(el);
  }
}

// ── System prompt ─────────────────────────────────────────
function buildSystemPrompt() {
  const ctx = simaPageCtx;
  let pageSection = '';

  if (ctx) {
    const isProduct = ['product-ozon','product-wb','product-yandex'].includes(ctx.type);
    if (isProduct) {
      const mp = ctx.marketplace || ctx.type;
      const lines = [`Пользователь смотрит страницу товара на ${mp}.`, `URL: ${ctx.url}`];
      if (ctx.title)         lines.push(`Название: ${ctx.title}`);
      if (ctx.brand)         lines.push(`Бренд: ${ctx.brand}`);
      if (ctx.category)      lines.push(`Категория: ${ctx.category}`);
      if (ctx.price)         lines.push(`Цена: ${ctx.price} ₽`);
      if (ctx.originalPrice) lines.push(`Цена без скидки: ${ctx.originalPrice} ₽`);
      if (ctx.discount)      lines.push(`Скидка: ${ctx.discount}%`);
      if (ctx.rating)        lines.push(`Рейтинг: ${ctx.rating}/5`);
      if (ctx.reviewsCount)  lines.push(`Отзывов: ${ctx.reviewsCount}`);
      if (ctx.seller)        lines.push(`Продавец: ${ctx.seller}`);
      if (ctx.description)   lines.push(`Описание: ${ctx.description.slice(0, 600)}`);
      pageSection = '\n\nКОНТЕКСТ СТРАНИЦЫ:\n' + lines.join('\n');
    } else if (ctx.type === 'seller-ozon') {
      pageSection = `\n\nКОНТЕКСТ: Кабинет продавца Ozon. URL: ${ctx.url}`;
    } else if (ctx.type === 'seller-yandex') {
      pageSection = `\n\nКОНТЕКСТ: Кабинет Яндекс Маркет. URL: ${ctx.url}`;
    } else if (ctx.type === 'simadesk') {
      pageSection = `\n\nКОНТЕКСТ: Приложение SimaDesk. URL: ${ctx.url}`;
    } else if (ctx.title) {
      pageSection = `\n\nКОНТЕКСТ: Страница «${ctx.title}». URL: ${ctx.url}`;
      if (ctx.bodyText) pageSection += `\nТекст: ${ctx.bodyText.slice(0, 800)}`;
    }
  }

  return `Ты — Сима, AI-ассистент для продавцов на маркетплейсах (Ozon, Wildberries, Яндекс Маркет). Ты работаешь в расширении браузера SimaDesk и видишь страницу пользователя.

Ты помогаешь с: анализом товаров и ниш, ценообразованием, стратегией продаж, анализом отзывов, советами по карточке товара, юнит-экономикой.

Отвечай по-русски. Будь конкретным — давай чёткие рекомендации, не общие слова. Используй данные о товаре если они есть.${pageSection}`;
}

// ── Render helpers ────────────────────────────────────────
function addMessage(role, text) {
  const welcome = document.getElementById('sima-welcome');
  if (welcome) welcome.style.display = 'none';

  const msgs = document.getElementById('sima-messages');

  const wrap = document.createElement('div');
  wrap.className = `msg-wrap ${role}`;

  const el = document.createElement('div');
  el.className = `sima-msg ${role}`;
  el.textContent = text;
  wrap.appendChild(el);

  // Copy button (hidden until hover via CSS)
  if (role !== 'error') {
    const btn = document.createElement('button');
    btn.className = 'msg-copy';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Копировать`;
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Скопировано`;
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Копировать`;
          btn.classList.remove('copied');
        }, 2000);
      });
    });
    wrap.appendChild(btn);
  }

  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}

function addSnippet(label, content) {
  const welcome = document.getElementById('sima-welcome');
  if (welcome) welcome.style.display = 'none';

  const msgs = document.getElementById('sima-messages');
  const el = document.createElement('div');
  el.className = 'sima-snippet';
  el.innerHTML = `<b>${label}</b>${content}`;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function addThinking() {
  const msgs = document.getElementById('sima-messages');
  const el = document.createElement('div');
  el.className = 'sima-thinking';
  el.innerHTML = '<span></span><span></span><span></span>';
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}

// ── API call ──────────────────────────────────────────────
async function sendSimaMessage(text, extraContext) {
  if (!text?.trim() || simaLoading) return;

  if (getDailyRemaining() <= 0) {
    addMessage('error', `Дневной лимит токенов исчерпан (${Math.round(getDailyLimit()/1000)}К). Лимиты общие с SimaDesk — пополни пакет AI в настройках SimaDesk.`);
    return;
  }

  simaLoading = true;

  const sendBtn = document.getElementById('sima-send');
  const input   = document.getElementById('sima-input');
  if (sendBtn) sendBtn.disabled = true;
  if (input)   { input.value = ''; input.style.height = 'auto'; }

  // If there's extra context (from picker), show it as snippet + include in message
  if (extraContext) addSnippet('Выбранный элемент', extraContext);

  const fullText = extraContext
    ? `${text}\n\n[Контекст со страницы]\n${extraContext}`
    : text;

  addMessage('user', text);
  simaHistory.push({ role: 'user', content: fullText });

  const thinking = addThinking();

  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${simaApiKey}`,
        'HTTP-Referer': 'https://simadesk.ru',
        'X-Title': 'SimaDesk Extension',
      },
      body: JSON.stringify({
        model: SIMA_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          ...simaHistory,
        ],
        max_tokens: 1200,
        temperature: 0.7,
      }),
    });

    thinking.remove();

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`${resp.status}: ${errText.slice(0, 120)}`);
    }

    const data  = await resp.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error('Пустой ответ от модели');

    simaHistory.push({ role: 'assistant', content: reply });
    addMessage('assistant', reply);
    if (simaHistory.length > 20) simaHistory = simaHistory.slice(-20);

    // Record token usage (estimate from usage field or count chars)
    const used = data.usage?.total_tokens ?? Math.round((buildSystemPrompt().length + fullText.length + reply.length) / 4);
    recordTokens(used);
  } catch (e) {
    thinking.remove();
    addMessage('error', `Ошибка: ${e.message}`);
  } finally {
    simaLoading = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
  }
}

// ── Element Picker (Cursor-style) ─────────────────────────
async function startPick() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    pickTabId = tab.id;

    await chrome.tabs.sendMessage(tab.id, { type: 'sima-pick-start' });

    pickModeOn = true;
    document.getElementById('sima-pick')?.classList.add('on');
    document.getElementById('pick-bar')?.classList.add('visible');

    // Auto-cancel after 30s
    setTimeout(() => { if (pickModeOn) cancelPick(); }, 30000);
  } catch {
    addMessage('error', 'Не удалось активировать выбор — попробуй обновить страницу.');
  }
}

function cancelPick() {
  pickModeOn = false;
  document.getElementById('sima-pick')?.classList.remove('on');
  document.getElementById('pick-bar')?.classList.remove('visible');
  if (pickTabId) {
    chrome.tabs.sendMessage(pickTabId, { type: 'sima-pick-cancel' }).catch(() => {});
  }
}

function onPickResult(msg) {
  if (!pickModeOn) return;
  cancelPick();

  const text = msg.text?.trim() || '';
  const tag  = msg.tag  || '';
  if (!text) return;

  // Put snippet text in input so user can add a question, OR auto-send with default question
  const input = document.getElementById('sima-input');
  if (input) {
    input.value = 'Что это означает и как это поможет мне продавать на маркетплейсе?';
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 80) + 'px';
    input.focus();
  }

  // Store context to attach when user sends
  pendingPickContext = `<${tag}> ${text.slice(0, 600)}`;
}

let pendingPickContext = null;

document.getElementById('sima-pick')?.addEventListener('click', () => {
  if (pickModeOn) { cancelPick(); return; }
  startPick();
});

document.getElementById('pick-cancel')?.addEventListener('click', cancelPick);

// ── Key management ────────────────────────────────────────
function showNoSync() {
  document.getElementById('sima-no-sync').style.display = '';
  document.getElementById('sima-chat').style.display = 'none';
}

function showChat() {
  document.getElementById('sima-no-sync').style.display = 'none';
  const chat = document.getElementById('sima-chat');
  chat.style.display = 'flex';
  updateQuotaBar();
  loadPageContext();
}

// ── Input: textarea auto-resize + send ───────────────────
const simaInputEl = document.getElementById('sima-input');
const simaSendEl  = document.getElementById('sima-send');

simaInputEl?.addEventListener('input', () => {
  simaInputEl.style.height = 'auto';
  simaInputEl.style.height = Math.min(simaInputEl.scrollHeight, 80) + 'px';
});

simaInputEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = simaInputEl.value.trim();
    if (text) {
      const ctx = pendingPickContext;
      pendingPickContext = null;
      sendSimaMessage(text, ctx);
    }
  }
});

simaSendEl?.addEventListener('click', () => {
  const text = simaInputEl?.value?.trim();
  if (text) {
    const ctx = pendingPickContext;
    pendingPickContext = null;
    sendSimaMessage(text, ctx);
  }
});

// Static hint clicks
document.querySelectorAll('#hints-grid .hint').forEach(h => {
  h.addEventListener('click', () => sendSimaMessage(h.dataset.hint || h.textContent.replace(/^[^ ]+ /, '')));
});

// ── Init ──────────────────────────────────────────────────
async function initSima() {
  const stored = await chrome.storage.local.get(['sima_ai_key', 'sima_used_today', 'sima_boost']);
  simaApiKey    = stored.sima_ai_key    || '';
  simaUsedToday = stored.sima_used_today || 0;
  simaBoost     = stored.sima_boost      || '';
  if (simaApiKey) { showChat(); } else { showNoSync(); }
}

initSima();
