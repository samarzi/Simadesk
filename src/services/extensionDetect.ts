/**
 * Определение, установлено ли расширение SimaDesk у пользователя.
 *
 * Расширение инжектит content script (simadesk-bridge), который
 * выставляет window.__SIMADESK_EXTENSION_ID — по нему пингуем
 * background.js через chrome.runtime.sendMessage.
 */

export async function detectSimaDeskExtension(): Promise<boolean> {
  const chrome = (window as any).chrome;
  if (!chrome?.runtime?.sendMessage) return false;

  const extensionId = (window as any).__SIMADESK_EXTENSION_ID;
  if (!extensionId) return false;

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    try {
      chrome.runtime.sendMessage(extensionId, { type: 'ping' }, (res: any) => {
        if (chrome.runtime.lastError) { finish(false); return; }
        finish(res?.type === 'pong');
      });
    } catch { finish(false); }
    setTimeout(() => finish(false), 2000);
  });
}
