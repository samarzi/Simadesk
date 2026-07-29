import { debug } from './debug';

/**
 * Поглощает ошибку промиса в фоновых fire-and-forget операциях.
 * Логирует через debug.warn с контекстом — не молчит.
 * Использовать только для: IDB writes, фоновые синхронизации, preload.
 * Для бизнес-логики и пользовательских действий — всплывать ошибку.
 */
export function swallow(promise: Promise<unknown>, context: string): void {
  promise.catch((e: unknown) => {
    debug.warn(`[swallow] ${context}`, e);
  });
}
