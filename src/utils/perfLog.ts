/**
 * Диагностика зависаний. Пишет в консоль:
 *   [perf] долгая задача 1234 мс (на 2.3 с после загрузки) — что выполнялось
 * Последний отмеченный этап (perfMark) подсказывает, чем был занят главный поток.
 * Выключить: localStorage.sd_perf = 'off'.
 */

let current = 'запуск приложения';
const enabled = (() => { try { return localStorage.getItem('sd_perf') !== 'off'; } catch { return true; } })();

/** Отметить, что сейчас выполняется (для подписи долгих задач). */
export function perfMark(stage: string): void { current = stage; }

/** Выполнить и залогировать, если заняло больше порога. */
export function perfTime<T>(label: string, fn: () => T, thresholdMs = 50): T {
  if (!enabled) return fn();
  const prev = current;
  current = label;
  const t = performance.now();
  try { return fn(); }
  finally {
    const dt = performance.now() - t;
    if (dt >= thresholdMs) console.warn(`[perf] ${label}: ${Math.round(dt)} мс`);
    current = prev;
  }
}

export function installPerfLog(): void {
  if (!enabled || typeof PerformanceObserver === 'undefined') return;
  try {
    const obs = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (e.duration < 100) continue;
        console.warn(`[perf] долгая задача ${Math.round(e.duration)} мс (на ${(e.startTime / 1000).toFixed(1)} с после загрузки) — ${current}`);
      }
    });
    obs.observe({ type: 'longtask', buffered: true });
  } catch { /* браузер без longtask — просто не логируем */ }
}
