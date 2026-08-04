/**
 * Иконки админ-панели — единый набор штриховых SVG (24×24, stroke=currentColor).
 * Эмодзи в панели не используются: всё, что раньше было символами, теперь иконки.
 */

const P: Record<string, string> = {
  /* навигация */
  dashboard:  '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  analytics:  '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 15l3.5-4 3 2.5L20 7"/>',
  users:      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  building:   '<path d="M3 21h18"/><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M15 21V11h4a2 2 0 0 1 2 2v8"/><path d="M9 7h2M9 11h2M9 15h2"/>',
  card:       '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  tag:        '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  chat:       '<path d="M21 14a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  settings:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
  page:       '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
  roadmap:    '<path d="M9 6l-6 3v13l6-3 6 3 6-3V6l-6 3-6-3z"/><path d="M9 6v13M15 9v13"/>',

  /* действия */
  search:     '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  refresh:    '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  plus:       '<path d="M12 5v14M5 12h14"/>',
  close:      '<path d="M18 6L6 18M6 6l12 12"/>',
  check:      '<path d="M20 6L9 17l-5-5"/>',
  trash:      '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  ban:        '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  edit:       '<path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  clock:      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  calendar:   '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  external:   '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
  back:       '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
  logout:     '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  collapse:   '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  send:       '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  paperclip:  '<path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  image:      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  filter:     '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  key:        '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.8 12.2L21 2"/><path d="M17 6l3 3M14.5 8.5l3 3"/>',
  bot:        '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.4"/><path d="M9 13.5h.01M15 13.5h.01"/><path d="M9.5 17h5"/>',
  sparkle:    '<path d="M12 3l2.1 5.6L20 10.5l-5.9 1.9L12 18l-2.1-5.6L4 10.5l5.9-1.9z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  zap:        '<path d="M13 2L4.5 13.5H12l-1 8.5 8.5-11.5H12z"/>',
  ruble:      '<path d="M8 21V4h5.5a4.5 4.5 0 0 1 0 9H6"/><path d="M6 17h7"/>',
  trend:      '<path d="M22 7l-8.5 8.5-4-4L2 19"/><path d="M16 7h6v6"/>',
  shield:     '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  info:       '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
  warn:       '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  alert:      '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  help:       '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  bulb:       '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.1 14a5.5 5.5 0 1 0-6.2 0c.6.5 1.1 1.2 1.1 2h4c0-.8.5-1.5 1.1-2z"/>',
  wrench:     '<path d="M14.7 6.3a4 4 0 1 0 5 5L21 12a5.5 5.5 0 0 1-7.5 7L6 21l-3-3 2-7.5A5.5 5.5 0 0 1 12 3z"/>',
  chevron:    '<path d="M9 18l6-6-6-6"/>',
  cornerDown: '<path d="M9 10l-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  command:    '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12"/>',
  inbox:      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  userPlus:   '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  db:         '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
};

/** Отрисовать иконку. `size` — сторона квадрата в px, `sw` — толщина штриха. */
export function icon(name: string, size = 16, sw = 1.9): string {
  const d = P[name];
  if (!d) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

export const ICON_NAMES = Object.keys(P);
