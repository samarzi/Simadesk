/**
 * SimaDesk Extension — Popup UI with terminal per task type.
 */
let port = null;
let tasksReady = false;          // флаг: tasksByType уже заполнен
const pendingMessages = [];      // буфер сообщений пришедших до загрузки задач

function connectPort() {
  port = chrome.runtime.connect({ name: 'popup' });
  port.onDisconnect.addListener(() => { port = null; });
  port.onMessage.addListener((msg) => {
    if (!tasksReady) {
      pendingMessages.push(msg); // копим пока задачи не загружены
    } else {
      onPortMessage(msg);
    }
  });
}

const statusLabels = {
  idle: 'Ожидание запуска',
  running: '▶ Выполняется',
  paused: '⏸ Пауза / Ручной режим',
  completed: '✅ Завершено',
  error: '❌ Ошибка',
  stopped: '⏹ Остановлено',
};

// Track tasks by type
const tasksByType = {};
const logsByType = {
  'yandex-warehouses': [],
  'yandex-tariffs': [],
  'ozon-warehouses': [],
};

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.task-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = document.querySelector(`[data-panel="${btn.dataset.tab}"]`);
    if (panel) panel.classList.add('active');
  });
});

function classifyLine(line) {
  const t = line.replace(/^\[[\d:]+\]\s*/, ''); // strip timestamp
  if (t.includes('❌')) return 'err';
  if (t.startsWith('✅') || t.startsWith('🏁') || t.startsWith('🚀')) return 'success';
  if (t.startsWith('⚠') || t.startsWith('↩')) return 'warn';
  if (t.startsWith('│') || t.startsWith('┌') || t.startsWith('└') || t.startsWith('├')) return 'info';
  if (t.startsWith('💾') || t.startsWith('→') || t.startsWith('   ↳')) return 'info';
  if (t.startsWith('[') && t.includes('█')) return 'info'; // progress bar
  return 'default';
}

function appendLog(type, line) {
  const terminal = document.getElementById(`terminal-${type}`);
  if (!terminal) return;

  // Clear empty state on first log
  const empty = terminal.querySelector('.empty-state');
  if (empty) empty.remove();

  logsByType[type].push(line);

  const div = document.createElement('div');
  div.className = `line ${classifyLine(line)}`;
  div.textContent = line;
  terminal.appendChild(div);
  terminal.scrollTop = terminal.scrollHeight;
}

function updateStatus(type, status) {
  const dot = document.getElementById(`status-${type}`);
  const text = document.getElementById(`status-text-${type}`);
  const stopBtn = document.getElementById(`stop-${type}`);
  const skipBtn = document.getElementById(`skip-${type}`);
  const pauseBtn = document.getElementById(`pause-${type}`);
  if (dot) {
    dot.className = `status-dot ${status}`;
  }
  if (text) {
    text.textContent = statusLabels[status] || status;
    text.style.color = status === 'running' ? '#3b82f6'
      : status === 'paused' ? '#06b6d4'
      : status === 'completed' ? '#22c55e'
      : status === 'error' ? '#ef4444'
      : status === 'stopped' ? '#f59e0b'
      : '#71717a';
  }
  const activeTask = status === 'running' || status === 'paused';
  if (stopBtn) {
    stopBtn.classList.toggle('visible', activeTask);
  }
  if (skipBtn) {
    skipBtn.classList.toggle('visible', activeTask);
  }
  if (pauseBtn) {
    pauseBtn.classList.toggle('visible', activeTask);
    if (status === 'paused') {
      pauseBtn.textContent = '▶ Продолжить';
      pauseBtn.classList.add('paused');
    } else {
      pauseBtn.textContent = '⏸ Пауза';
      pauseBtn.classList.remove('paused');
    }
  }
}

function updateProgress(type, done, total, label) {
  const bar = document.getElementById(`progress-${type}`);
  const text = document.getElementById(`progress-text-${type}`);
  if (bar && total > 0) {
    bar.style.width = `${Math.round((done / total) * 100)}%`;
  }
  if (text) {
    text.textContent = total > 0 ? `${done}/${total}${label ? ` • ${label}` : ''}` : '';
  }
}

// Connect port сразу (буферизует сообщения до готовности задач)
connectPort();

// Загружаем задачи → показываем исторические логи → разблокируем буфер
chrome.runtime.sendMessage({ type: 'get-tasks' }, (res) => {
  const taskList = res?.tasks || [];

  // Сначала заполняем tasksByType
  for (const t of taskList) {
    tasksByType[t.type] = t;
    updateStatus(t.type, t.status);
  }

  // Получаем исторические логи для каждой задачи
  let pending = taskList.length;
  if (pending === 0) {
    tasksReady = true;
    pendingMessages.splice(0).forEach(onPortMessage);
    return;
  }

  for (const t of taskList) {
    chrome.runtime.sendMessage({ type: 'get-logs', taskId: t.id, since: 0 }, (logRes) => {
      if (logRes?.logs) {
        for (const line of logRes.logs) appendLog(t.type, line);
      }
      pending--;
      if (pending === 0) {
        // Все логи загружены — разблокируем поток реального времени
        tasksReady = true;
        pendingMessages.splice(0).forEach(onPortMessage);
      }
    });
  }
});

// Listen for updates
function onPortMessage(msg) {
  if (msg.type === 'task-log') {
    const task = Object.values(tasksByType).find(t => t.id === msg.taskId);
    const type = task?.type;
    if (type) {
      appendLog(type, msg.line);
    }
  }

  if (msg.type === 'task-status') {
    const task = Object.values(tasksByType).find(t => t.id === msg.taskId);
    if (task) {
      task.status = msg.status;
      updateStatus(task.type, msg.status);
    }
    chrome.runtime.sendMessage({ type: 'get-tasks' }, (res) => {
      if (!res?.tasks) return;
      for (const t of res.tasks) {
        tasksByType[t.type] = t;
        updateStatus(t.type, t.status);
      }
    });
  }

  if (msg.type === 'task-progress') {
    const task = Object.values(tasksByType).find(t => t.id === msg.taskId);
    if (task) {
      updateProgress(task.type, msg.done, msg.total, msg.label);
    }
  }
}

// Stop buttons
document.querySelectorAll('.stop-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    const task = tasksByType[type];
    if (task && task.id) {
      if (!port) connectPort();
      try {
        port.postMessage({ type: 'stop-task', taskId: task.id });
      } catch (e) {
        connectPort();
        port.postMessage({ type: 'stop-task', taskId: task.id });
      }
      appendLog(type, `[${new Date().toLocaleTimeString('ru-RU')}] ⏹ Отправлена команда остановки`);
    }
  });
});

// Skip zone buttons (только для Ozon)
document.querySelectorAll('.skip-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    const task = tasksByType[type];
    if (task && task.id) {
      if (!port) connectPort();
      try {
        port.postMessage({ type: 'skip-zone', taskId: task.id });
      } catch (e) {
        connectPort();
        port.postMessage({ type: 'skip-zone', taskId: task.id });
      }
      appendLog(type, `[${new Date().toLocaleTimeString('ru-RU')}] ⏭ Пропуск зоны — переходим к сохранению`);
    }
  });
});

// Pause / Resume buttons
document.querySelectorAll('.pause-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    const task = tasksByType[type];
    if (task && task.id) {
      if (!port) connectPort();
      const isPaused = task.status === 'paused';
      const msgType = isPaused ? 'resume-task' : 'pause-task';
      const label = isPaused ? '▶ Продолжение' : '⏸ Пауза';
      try {
        port.postMessage({ type: msgType, taskId: task.id });
      } catch (e) {
        connectPort();
        port.postMessage({ type: msgType, taskId: task.id });
      }
      appendLog(type, `[${new Date().toLocaleTimeString('ru-RU')}] ${label} — команда отправлена`);
    }
  });
});

// Copy logs buttons
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    const logs = logsByType[type];
    if (!logs || logs.length === 0) return;
    const text = logs.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Скопировано!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('copied');
      }, 2000);
    });
  });
});
