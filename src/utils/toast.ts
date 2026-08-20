/**
 * Global toast utility — works without the App instance.
 * Uses the same #toasts container and CSS as App.toast().
 */

export interface ToastOpts {
  link?:  { url: string; label?: string };
  image?: string;
  video?: string;
}

export function showToast(
  msg: string,
  type: 'success' | 'error' | 'info' | 'warning' = 'info',
  ms = 3000,
  opts: ToastOpts = {},
): void {
  if (window.app?.toast) { window.app.toast(msg, type, ms, opts); return; }

  const wrap = document.getElementById('toasts');
  if (!wrap) return;

  const ICONS: Record<string, string> = {
    success: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 8 6 12 14 4"/></svg>`,
    error:   `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`,
    warning: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L14.5 13H1.5L8 2z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r="0.5" fill="currentColor"/></svg>`,
    info:    `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5.5" r="0.5" fill="currentColor"/></svg>`,
  };
  const STAR        = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  const STAR_FILLED = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  const LINK_ICON   = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5L7 4"/><path d="M9.5 6.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5L9 12"/></svg>`;

  const LABELS: Record<string, string> = {
    success: 'Успешно',
    error:   'Ошибка',
    info:    'Информация',
    warning: 'Предупреждение',
  };

  const mediaHTML = opts.image
    ? `<img class="toast-media" src="${opts.image}" alt="" loading="lazy" />`
    : opts.video
      ? `<video class="toast-media" src="${opts.video}" controls preload="none"></video>`
      : '';
  const linkHTML = opts.link
    ? `<a class="toast-link" href="${opts.link.url}" target="_blank" rel="noopener">${LINK_ICON} ${opts.link.label ?? opts.link.url}</a>`
    : '';

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <div class="toast-header">
      <span class="toast-icon">${ICONS[type] ?? ICONS.info}</span>
      <span class="toast-type">${LABELS[type] ?? type}</span>
      <div class="toast-actions">
        <button class="toast-pin" title="Отметить как важное">${STAR}</button>
        <button class="toast-close" aria-label="Закрыть">✕</button>
      </div>
    </div>
    <span class="toast-msg">${msg}</span>
    ${linkHTML}${mediaHTML}
    <span class="toast-bar" style="animation-duration:${ms}ms"></span>`;

  const dismiss = () => {
    el.style.animation = 'toastOut .2s ease forwards';
    setTimeout(() => el.remove(), 200);
  };

  let timer = window.setTimeout(dismiss, ms);

  el.querySelector('.toast-close')!.addEventListener('click', dismiss);
  el.querySelector('.toast-pin')!.addEventListener('click', () => {
    const pinned = el.classList.toggle('pinned');
    const btn = el.querySelector('.toast-pin')!;
    btn.classList.toggle('active', pinned);
    btn.innerHTML = pinned ? STAR_FILLED : STAR;
    if (pinned) {
      window.clearTimeout(timer);
    } else {
      timer = window.setTimeout(dismiss, ms);
    }
  });

  wrap.appendChild(el);
}
