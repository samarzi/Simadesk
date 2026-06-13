/**
 * Global toast utility — works without the App instance.
 * Uses the same #toasts container and CSS as App.toast().
 */
export function showToast(
  msg: string,
  type: 'success' | 'error' | 'info' | 'warning' = 'info',
  ms = 3000,
): void {
  // Try delegating to App.toast() if app is already booted
  if (window.app?.toast) {
    window.app.toast(msg, type, ms);
    return;
  }

  // Fallback: render directly into #toasts
  const wrap = document.getElementById('toasts');
  if (!wrap) return;

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut .2s ease forwards';
    setTimeout(() => el.remove(), 220);
  }, ms);
}
