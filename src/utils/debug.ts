/**
 * Debug logger — only outputs when localStorage.debug === 'true'.
 * Safe to leave in production: all calls are no-ops unless debug mode is on.
 */

type LogLevel = 'log' | 'warn' | 'error';

class DebugLogger {
  private static instance: DebugLogger;
  private _enabled: boolean;

  private constructor() {
    this._enabled = typeof localStorage !== 'undefined'
      ? localStorage.getItem('debug') === 'true'
      : false;
  }

  static getInstance(): DebugLogger {
    if (!DebugLogger.instance) {
      DebugLogger.instance = new DebugLogger();
    }
    return DebugLogger.instance;
  }

  get enabled(): boolean { return this._enabled; }

  enable(): void {
    this._enabled = true;
    localStorage.setItem('debug', 'true');
    console.log('[Debug] Debug mode enabled. Reload to see all logs.');
  }

  disable(): void {
    this._enabled = false;
    localStorage.removeItem('debug');
  }

  private out(level: LogLevel, prefix: string, message: string, data?: unknown): void {
    if (!this._enabled) return;
    const fn = console[level] ?? console.log;
    if (data !== undefined) {
      fn(`${prefix} ${message}`, data);
    } else {
      fn(`${prefix} ${message}`);
    }
  }

  log(message: string, data?: unknown): void {
    this.out('log', '[DEBUG]', message, data);
  }

  error(message: string, error?: unknown): void {
    this.out('error', '[ERROR]', message, error);
  }

  warn(message: string, data?: unknown): void {
    this.out('warn', '[WARN]', message, data);
  }

  api(method: string, endpoint: string, data?: unknown): void {
    this.out('log', '[API]', `${method} ${endpoint}`, data);
  }

  state(action: string, data?: unknown): void {
    this.out('log', '[STATE]', action, data);
  }

  /**
   * Measure execution time of an async operation.
   * Usage: const result = await debug.time('loadProducts', () => apiService.getProducts())
   */
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!this._enabled) return fn();
    const start = performance.now();
    try {
      const result = await fn();
      const ms = (performance.now() - start).toFixed(1);
      console.log(`[PERF] ${label}: ${ms}ms`);
      return result;
    } catch (e) {
      const ms = (performance.now() - start).toFixed(1);
      console.error(`[PERF] ${label} FAILED after ${ms}ms`, e);
      throw e;
    }
  }

  /** @deprecated Use debug.time() instead */
  perf(label: string, startTime?: number): number {
    if (!this._enabled) return 0;
    if (startTime !== undefined) {
      const duration = performance.now() - startTime;
      console.log(`[PERF] ${label}: ${duration.toFixed(2)}ms`);
      return 0;
    }
    console.log(`[PERF] Starting ${label}...`);
    return performance.now();
  }
}

export const debug = DebugLogger.getInstance();
