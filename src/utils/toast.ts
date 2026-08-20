/**
 * Global toast utility — works without the App instance.
 * Uses the same #toasts container and CSS as App.toast().
 */
export function showToast(
  msg: string,
  type: 'success' | 'error' | 'info' | 'warning' = 'info',
  ms = 3000,
): void {
  if (window.app?.toast) { window.app.toast(msg, type, ms); return; }

  const wrap = document.getElementById('toasts');
  if (!wrap) return;

  const ICONS: Record<string, string> = {
    success: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 8 6 12 14 4"/></svg>`,
    error:   `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`,
    warning: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L14.5 13H1.5L8 2z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r="0.5" fill="currentColor"/></svg>`,
    info:    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5.5" r="0.5" fill="currentColor"/></svg>`,
  };

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <span class="toast-icon">${ICONS[type] ?? ICONS.info}</span>
    <span class="toast-msg">${msg}</span>
    <button class="toast-close" aria-label="Закрыть">✕</button>
    <span class="toast-bar" style="animation-duration:${ms}ms"></span>`;

  const dismiss = () => {
    el.style.animation = 'toastOut .2s ease forwards';
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close')!.addEventListener('click', dismiss);
  wrap.appendChild(el);
  setTimeout(dismiss, ms);
}
