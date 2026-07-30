/**
 * Учёт расхода токенов на запросы к AI.
 *
 * Каждый вызов модели показывает карточку в правом верхнем углу: сколько ушло
 * на запрос, сколько на ответ и сколько накопилось за сессию. Подключается ко
 * всем местам, где дёргается OpenRouter — ассистент, поддержка, аналитика,
 * генерация карточек.
 */

export interface AiUsage {
  prompt: number;
  completion: number;
  total: number;
  /** Стоимость в USD — OpenRouter отдаёт её не всегда. */
  cost?: number;
}

interface SessionTotals {
  prompt: number;
  completion: number;
  total: number;
  cost: number;
  calls: number;
}

const STORE_KEY = 'sd_ai_usage_session';

function loadTotals(): SessionTotals {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as SessionTotals;
  } catch { /* повреждённое значение — начинаем с нуля */ }
  return { prompt: 0, completion: 0, total: 0, cost: 0, calls: 0 };
}

let totals = loadTotals();

function saveTotals(): void {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(totals)); } catch { /* приватный режим */ }
}

/** Итоги за текущую сессию — для экранов статистики. */
export function getSessionUsage(): SessionTotals {
  return { ...totals };
}

export function resetSessionUsage(): void {
  totals = { prompt: 0, completion: 0, total: 0, cost: 0, calls: 0 };
  saveTotals();
}

/** Разобрать блок usage из ответа OpenRouter (у разных моделей поля разнятся). */
export function parseUsage(response: unknown): AiUsage | null {
  const u = (response as any)?.usage;
  if (!u || typeof u !== 'object') return null;

  const prompt     = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const total      = Number(u.total_tokens ?? 0) || prompt + completion;
  if (total <= 0) return null;

  const costRaw = Number(u.cost ?? u.total_cost);
  return {
    prompt, completion, total,
    ...(Number.isFinite(costRaw) && costRaw > 0 ? { cost: costRaw } : {}),
  };
}

const nf = new Intl.NumberFormat('ru-RU');

/**
 * Записать расход и показать уведомление.
 * `label` — что именно потратило токены («Сима», «Поддержка AI», …).
 */
export function reportAiUsage(label: string, response: unknown): AiUsage | null {
  const usage = parseUsage(response);
  if (!usage) return null;

  totals.prompt     += usage.prompt;
  totals.completion += usage.completion;
  totals.total      += usage.total;
  totals.cost       += usage.cost ?? 0;
  totals.calls      += 1;
  saveTotals();

  showUsageCard(label, usage);
  return usage;
}

// ── Уведомление ───────────────────────────────────────────────────────────────

function ensureHost(): HTMLElement {
  let host = document.getElementById('sd-ai-usage-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'sd-ai-usage-host';
    document.body.appendChild(host);
  }
  return host;
}

/** Является ли текущий сеанс административным (стоимость показываем только им). */
function isAdminSession(): boolean {
  // adminService кэширует результат в памяти; читаем синхронно через быстрый флаг
  // который AssistantModule устанавливает после async checkAdmin()
  return (window as any).__sdAdminUser === true;
}

function showUsageCard(label: string, usage: AiUsage): void {
  if (typeof document === 'undefined' || !document.body) return;

  const host = ensureHost();
  const card = document.createElement('div');
  card.className = 'sd-ai-usage';

  // Стоимость показываем только администраторам
  const showCost = isAdminSession();
  const costLine = showCost && usage.cost !== undefined
    ? `<span class="sd-ai-usage-cost">$${usage.cost.toFixed(4)}</span>`
    : '';
  const sumCost = showCost && totals.cost > 0
    ? ` · $${totals.cost.toFixed(3)}`
    : '';

  card.innerHTML = `
    <div class="sd-ai-usage-top">
      <span class="sd-ai-usage-label">${escapeHtml(label)}</span>
      <span class="sd-ai-usage-total">${nf.format(usage.total)}<span class="sd-ai-usage-unit">токенов</span></span>
    </div>
    <div class="sd-ai-usage-bar">
      <span class="sd-ai-usage-io" title="Запрос">↑ ${nf.format(usage.prompt)}</span>
      <span class="sd-ai-usage-io" title="Ответ">↓ ${nf.format(usage.completion)}</span>
      ${costLine}
    </div>
    <div class="sd-ai-usage-sum">За сессию: ${nf.format(totals.total)} · запросов: ${nf.format(totals.calls)}${sumCost}</div>`;

  host.appendChild(card);

  // Ограничиваем стопку, иначе серия запросов забьёт весь экран
  while (host.children.length > 4) host.firstElementChild?.remove();

  setTimeout(() => {
    card.classList.add('out');
    setTimeout(() => card.remove(), 220);
  }, 5000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
