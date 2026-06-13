/**
 * UserProfileModule — страница профиля пользователя.
 *
 * Показывает данные из Telegram (аватар, ник, ID, имя/фамилия).
 * Позволяет добавить/изменить отображаемое имя если в TG его нет.
 * Вызывается из переключателя компаний (кнопка "Профиль").
 */

import { authService, AuthUser } from '@/services/authService';
import { supaFetch } from '@/services/supabaseClient';
import { showToast } from '@/utils/toast';

export class UserProfileModule {
  private overlay: HTMLElement;

  constructor() {
    // Создаём оверлей один раз
    this.overlay = document.createElement('div');
    this.overlay.className = 'profile-overlay hidden';
    this.overlay.id = 'profile-overlay';
    document.body.appendChild(this.overlay);
    this.addStyles();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  open(): void {
    this.render();
    this.overlay.classList.remove('hidden');
  }

  close(): void {
    this.overlay.classList.add('hidden');
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private async render(): Promise<void> {
    const localUser = authService.getUser();
    const twaUser   = authService.getTelegramWebAppUser();
    // Мёрджим: TMA-данные имеют приоритет (свежее), локальные — фолбэк
    const user: Partial<AuthUser> = { ...localUser, ...(twaUser ?? {}) };

    // Загружаем актуальные данные из Supabase users (фильтр по id текущего пользователя)
    let dbUser: any = null;
    try {
      const uid = localUser?.id;
      const rows = uid
        ? await supaFetch<any[]>(`users?id=eq.${uid}&select=*&limit=1`)
        : await supaFetch<any[]>('users?select=*&limit=1');
      dbUser = rows?.[0] ?? null;
    } catch { /* offline — используем кэш */ }

    const displayUser = dbUser ?? user;
    const hasPhoto    = !!displayUser.photo_url;
    const firstName   = displayUser.first_name  || '';
    const lastName    = displayUser.last_name   || '';
    const username    = displayUser.telegram_username || displayUser.username || '';
    const telegramId  = displayUser.telegram_id  || localUser?.id || '—';
    const displayName = displayUser.display_name || '';
    const fullName    = [firstName, lastName].filter(Boolean).join(' ');

    this.overlay.innerHTML = `
      <div class="profile-card">
        <div class="profile-head">
          <div class="profile-title">Мой профиль</div>
          <button class="profile-close" id="profile-close-btn">✕</button>
        </div>

        <!-- Аватар + основное -->
        <div class="profile-hero">
          <div class="profile-avatar-wrap">
            <img class="profile-avatar" id="profile-photo-img"
              src="${hasPhoto ? this.esc(displayUser.photo_url) : ''}"
              alt="avatar"
              referrerpolicy="no-referrer"
              style="${hasPhoto ? '' : 'display:none'}"
              onerror="this.style.display='none';document.getElementById('profile-photo-fallback').style.display='flex'">
            <div class="profile-avatar-fallback" id="profile-photo-fallback"
              style="${hasPhoto ? 'display:none' : ''}">
              ${(firstName || username || '?').charAt(0).toUpperCase()}
            </div>
          </div>

          <div class="profile-hero-info">
            <div class="profile-name">${this.esc(fullName || username || 'Пользователь')}</div>
            ${username ? `<div class="profile-username">@${this.esc(username)}</div>` : ''}
            <div class="profile-tg-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248l-2.026 9.547c-.148.666-.54.828-1.094.515l-3.03-2.232-1.46 1.406c-.163.163-.298.298-.61.298l.218-3.088 5.62-5.08c.245-.218-.053-.337-.38-.12L7.26 13.988l-2.97-.926c-.644-.203-.657-.644.135-.953l11.572-4.462c.537-.195 1.006.131.565 2.601z"/>
              </svg>
              Telegram ID: <span class="profile-tg-id" id="profile-tg-id" title="Нажмите чтобы скопировать" style="cursor:pointer">${telegramId}</span>
            </div>
          </div>
        </div>

        <!-- Поля профиля -->
        <div class="profile-fields">

          <div class="profile-field-row">
            <div class="profile-field-label">Имя (из Telegram)</div>
            <div class="profile-field-value">${this.esc(firstName) || '<span style="color:var(--text3)">не указано</span>'}</div>
          </div>

          <div class="profile-field-row">
            <div class="profile-field-label">Фамилия (из Telegram)</div>
            <div class="profile-field-value">${this.esc(lastName) || '<span style="color:var(--text3)">не указано</span>'}</div>
          </div>

          <div class="profile-field-row">
            <div class="profile-field-label">Username</div>
            <div class="profile-field-value">${username ? `@${this.esc(username)}` : '<span style="color:var(--text3)">не указан</span>'}</div>
          </div>

          <!-- Отображаемое имя — можно задать вручную -->
          <div class="profile-field-edit">
            <label class="profile-field-label" for="profile-display-name">
              Отображаемое имя
              <span style="color:var(--text3);font-weight:400;margin-left:4px">— как вас видят коллеги</span>
            </label>
            <div style="display:flex;gap:8px;margin-top:5px">
              <input
                class="profile-input"
                id="profile-display-name"
                placeholder="${this.esc(fullName || username || 'Введите имя...')}"
                value="${this.esc(displayName)}"
                maxlength="60"
              >
              <button class="profile-save-btn" id="profile-save-name-btn">
                Сохранить
              </button>
            </div>
          </div>
        </div>

        <!-- Выход -->
        <div class="profile-footer">
          <button class="profile-logout-btn" id="profile-logout-btn">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M10 3h3v10h-3M7 5l-4 3 4 3M3 8h8"/>
            </svg>
            Выйти из аккаунта
          </button>
        </div>
      </div>
    `;

    this.bindEvents(displayUser, telegramId);
  }

  private bindEvents(_user: any, telegramId: any): void {
    // Закрыть
    document.getElementById('profile-close-btn')?.addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Копировать Telegram ID
    document.getElementById('profile-tg-id')?.addEventListener('click', () => {
      navigator.clipboard.writeText(String(telegramId)).catch(() => {});
      showToast('Telegram ID скопирован', 'success', 1500);
    });

    // Сохранить отображаемое имя
    document.getElementById('profile-save-name-btn')?.addEventListener('click', async () => {
      const input = document.getElementById('profile-display-name') as HTMLInputElement;
      const btn   = document.getElementById('profile-save-name-btn') as HTMLButtonElement;
      const name  = input.value.trim();
      btn.disabled = true;
      btn.textContent = '...';
      try {
        // Сохраняем в таблицу users
        await supaFetch(`users?id=eq.${authService.getUser()?.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ display_name: name || null }),
        });
        // Обновляем локальный кэш
        const current = authService.getUser();
        if (current) {
          localStorage.setItem('sb_user', JSON.stringify({ ...current, display_name: name || null }));
        }
        showToast('Имя сохранено ✓', 'success');
        btn.textContent = 'Сохранено ✓';
      } catch {
        showToast('Ошибка сохранения', 'error');
        btn.textContent = 'Сохранить';
      } finally {
        btn.disabled = false;
      }
    });

    // Выход
    document.getElementById('profile-logout-btn')?.addEventListener('click', () => {
      if (!confirm('Выйти из аккаунта?')) return;
      authService.clearSession();
      location.reload();
    });
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  private addStyles(): void {
    if (document.getElementById('profile-styles')) return;
    const style = document.createElement('style');
    style.id = 'profile-styles';
    style.textContent = `
      .profile-overlay {
        position: fixed; inset: 0; z-index: 7000;
        background: rgba(0,0,0,.7);
        display: flex; align-items: center; justify-content: center; padding: 24px;
        backdrop-filter: blur(4px);
        animation: auth-fade-in .2s ease;
      }
      .profile-overlay.hidden { display: none; }
      .profile-card {
        width: 100%; max-width: 420px;
        background: var(--bg2); border: 1px solid var(--border2);
        border-radius: 18px; overflow: hidden;
        box-shadow: 0 24px 60px rgba(0,0,0,.7);
      }
      .profile-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 18px 20px 0;
      }
      .profile-title { font-family: 'Outfit',sans-serif; font-weight: 700; font-size: 16px; color: var(--text); }
      .profile-close {
        background: none; border: none; color: var(--text3);
        font-size: 14px; cursor: pointer; padding: 4px 6px; border-radius: 6px;
        transition: color .15s, background .15s;
      }
      .profile-close:hover { color: var(--text); background: var(--hover); }
      .profile-hero {
        display: flex; align-items: center; gap: 16px;
        padding: 20px;
      }
      .profile-avatar-wrap { position: relative; width: 64px; height: 64px; flex-shrink: 0; }
      .profile-avatar { width: 64px; height: 64px; border-radius: 50%; object-fit: cover; }
      .profile-avatar-fallback {
        width: 64px; height: 64px; border-radius: 50%;
        background: linear-gradient(135deg, #005bff, #7c3aed);
        display: flex; align-items: center; justify-content: center;
        font-family: 'Outfit',sans-serif; font-weight: 800; font-size: 24px; color: #fff;
      }
      .profile-hero-info { flex: 1; min-width: 0; }
      .profile-name { font-weight: 700; font-size: 16px; color: var(--text); margin-bottom: 2px; }
      .profile-username { font-size: 13px; color: var(--text2); margin-bottom: 6px; }
      .profile-tg-badge {
        display: inline-flex; align-items: center; gap: 5px;
        background: rgba(0,91,255,.12); color: #5b8fff;
        font-size: 11px; padding: 3px 8px; border-radius: 20px;
      }
      .profile-tg-id { font-weight: 600; }
      .profile-tg-id:hover { text-decoration: underline; }
      .profile-fields { padding: 0 20px 16px; display: flex; flex-direction: column; gap: 10px; }
      .profile-field-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 12px; background: var(--bg3); border-radius: 8px;
        border: 1px solid var(--border);
      }
      .profile-field-label { font-size: 11px; color: var(--text2); font-weight: 500; }
      .profile-field-value { font-size: 13px; color: var(--text); }
      .profile-field-edit {
        padding: 10px 12px; background: var(--bg3); border-radius: 8px;
        border: 1px solid var(--border);
      }
      .profile-input {
        flex: 1; padding: 8px 10px; border-radius: 8px;
        border: 1px solid var(--border2); background: var(--bg4);
        color: var(--text); font-size: 13px; font-family: inherit; outline: none;
        transition: border-color .15s;
      }
      .profile-input:focus { border-color: var(--accent); }
      .profile-save-btn {
        padding: 8px 14px; border-radius: 8px; border: none;
        background: var(--accent); color: #0a0a0a; font-size: 12px; font-weight: 600;
        cursor: pointer; white-space: nowrap; flex-shrink: 0;
        transition: opacity .15s;
      }
      .profile-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .profile-footer {
        padding: 12px 20px 18px;
        border-top: 1px solid var(--border);
      }
      .profile-logout-btn {
        display: flex; align-items: center; gap: 7px;
        background: none; border: 1px solid var(--red-dim);
        color: var(--red); font-size: 12px; font-family: inherit;
        padding: 8px 14px; border-radius: 8px; cursor: pointer;
        transition: background .15s;
      }
      .profile-logout-btn:hover { background: var(--red-dim); }
    `;
    document.head.appendChild(style);
  }

  private esc(str: string | null | undefined): string {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

export const userProfileModule = new UserProfileModule();
