/**
 * AuthModule — full-screen login gate.
 *
 * Shows when the user is not authenticated.
 * Renders the Telegram Login Widget and handles the auth callback.
 * In dev mode (VITE_DEV_AUTH=true) shows a bypass button.
 */

import { authService } from '@/services/authService';
import { I } from '@/utils/icons';

const IS_DEV_AUTH = import.meta.env.VITE_DEV_AUTH === 'true';
const BOT_USERNAME = import.meta.env.VITE_TG_BOT_USERNAME as string | undefined;

export class AuthModule {
  private el: HTMLElement;
  private onSuccess: () => void;

  constructor(el: HTMLElement, onSuccess: () => void) {
    this.el = el;
    this.onSuccess = onSuccess;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async show(): Promise<void> {
    // Если запущено как Telegram Mini App — входим автоматически
    if (authService.isTelegramMiniApp()) {
      await this.handleTelegramMiniApp();
      return;
    }
    this.el.classList.remove('hidden');
    this.render();
  }

  private async handleTelegramMiniApp(): Promise<void> {
    const twa = (window as any).Telegram?.WebApp;
    twa?.ready?.();
    twa?.expand?.();

    const initData = twa?.initData as string;
    if (!initData) {
      // initData пустой — показываем обычный экран входа
      this.el.classList.remove('hidden');
      this.render();
      return;
    }

    // Показываем заглушку-лоадер пока логинимся
    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="auth-card" style="gap:16px">
        <div class="auth-logo">SimaDesk</div>
        <div style="color:var(--text2);font-size:13px">Входим через Telegram...</div>
        <div style="width:32px;height:32px;border:2px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite"></div>
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;

    try {
      await authService.loginWithInitData(initData);
      this.success();
    } catch (err) {
      // Если не удалось — показываем обычный экран
      this.render();
    }
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private render(): void {
    this.el.innerHTML = `
      <div class="auth-card">
        <div class="auth-logo">SimaDesk</div>
        <div class="auth-tagline">Marketplace Desk</div>

        <div class="auth-headline">Вход в систему</div>
        <div class="auth-sub">
          Авторизуйтесь через Telegram —<br>
          быстро и без пароля
        </div>

        <div class="auth-error" id="auth-error"></div>

        <div class="auth-tg-wrap" id="tg-widget-wrap">
          ${this.renderWidget()}
        </div>

        ${IS_DEV_AUTH ? `
        <button class="auth-dev-btn" id="dev-login-btn">
          ${I.settings('',14)} DEV: войти без Telegram
        </button>
        ` : ''}

        <div class="auth-hint">
          Входя в систему, вы принимаете<br>
          <a href="/privacy" target="_blank">Политику конфиденциальности</a>
        </div>
      </div>
    `;

    // Register global callback for Telegram widget
    (window as any).onTelegramAuth = (data: Record<string, string>) => {
      this.handleTelegramAuth(data);
    };

    // Inject Telegram widget script via createElement (innerHTML blocks script execution)
    this.injectWidget();

    // Dev bypass
    if (IS_DEV_AUTH) {
      document.getElementById('dev-login-btn')?.addEventListener('click', () => {
        authService.devLogin();
        this.success();
      });
    }

    // If no bot username configured — show instructions
    if (!BOT_USERNAME && !IS_DEV_AUTH) {
      const wrap = document.getElementById('tg-widget-wrap');
      if (wrap) {
        wrap.innerHTML = `
          <div style="padding:16px;border:1px solid var(--border2);border-radius:10px;text-align:center;font-size:12px;color:var(--text2)">
            ${I.settings()} Настройте <code>VITE_TG_BOT_USERNAME</code> в .env<br>
            для включения Telegram-входа
          </div>
        `;
      }
    }
  }

  private renderWidget(): string {
    // Returns empty placeholder — actual script injected via injectWidget()
    // because <script> tags in innerHTML are NOT executed by browsers
    if (!BOT_USERNAME) return '';
    return `<div id="tg-widget-inner"></div>`;
  }

  private injectWidget(): void {
    if (!BOT_USERNAME) return;
    const container = document.getElementById('tg-widget-inner');
    if (!container) return;

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', BOT_USERNAME);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '8');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    container.appendChild(script);
  }

  // ── Auth handling ──────────────────────────────────────────────────────────

  private async handleTelegramAuth(data: Record<string, string>): Promise<void> {
    this.showError('');
    const btn = document.getElementById('tg-widget-wrap');
    if (btn) btn.style.opacity = '0.5';

    try {
      await authService.loginWithTelegram(data);
      this.success();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Ошибка входа. Попробуйте снова.';
      this.showError(msg);
      if (btn) btn.style.opacity = '1';
    }
  }

  private showError(msg: string): void {
    const el = document.getElementById('auth-error');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.add('visible');
    } else {
      el.classList.remove('visible');
    }
  }

  private success(): void {
    this.hide();
    this.onSuccess();
  }
}
