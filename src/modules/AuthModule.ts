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
const YANDEX_CLIENT_ID = import.meta.env.VITE_YANDEX_CLIENT_ID as string | undefined;

export class AuthModule {
  private el: HTMLElement;
  private onSuccess: () => void;

  constructor(el: HTMLElement, onSuccess: () => void) {
    this.el = el;
    this.onSuccess = onSuccess;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // Публичный метод для запуска привязки Яндекса к уже авторизованному аккаунту
  // (вызывается из main.ts после бута приложения)
  startYandexLink(token: string): void {
    this.handleYandexLink(token);
  }

  async show(yandexLoginToken?: string): Promise<void> {
    // Если запущено как Telegram Mini App — входим автоматически
    if (authService.isTelegramMiniApp()) {
      await this.handleTelegramMiniApp();
      return;
    }

    // Яндекс OAuth login token передан напрямую из main.ts
    if (yandexLoginToken) {
      await this.handleYandexToken(yandexLoginToken);
      return;
    }

    this.el.classList.remove('hidden');
    this.render();
  }

  private async handleYandexLink(token: string): Promise<void> {
    const overlay = this.createOverlay('Привязываем Яндекс ID...');
    document.body.appendChild(overlay);

    try {
      const result = await authService.linkYandex(token, false);
      overlay.remove();

      if (result.conflict) {
        await this.handleYandexMergeDialog(token);
        return;
      }

      (window as any).profileModule?.showAccountTab?.();
    } catch (err) {
      overlay.remove();
      const msg = err instanceof Error ? err.message : 'Ошибка привязки Яндекс';
      alert(msg);
    }
  }

  private async handleYandexMergeDialog(token: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const dialog = document.createElement('div');
      dialog.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:24px';
      dialog.innerHTML = `
        <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:20px;padding:32px;max-width:420px;width:100%;box-shadow:0 32px 80px rgba(0,0,0,.7)">
          <div style="font-size:28px;text-align:center;margin-bottom:12px">🔗</div>
          <div style="font-size:17px;font-weight:700;color:var(--text);text-align:center;margin-bottom:10px">Объединить аккаунты?</div>
          <div style="font-size:13px;color:var(--text2);line-height:1.6;text-align:center;margin-bottom:24px">
            Этот Яндекс ID уже зарегистрирован как отдельный профиль.<br><br>
            Если объединить — все <strong style="color:var(--text)">компании и данные</strong> из Яндекс-профиля перейдут в ваш текущий аккаунт. Яндекс-профиль будет удалён.<br><br>
            <span style="color:var(--text3);font-size:12px">Это действие необратимо.</span>
          </div>
          <div style="display:flex;gap:10px">
            <button id="merge-cancel" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--border2);background:var(--bg3);color:var(--text2);font-size:13px;font-weight:600;cursor:pointer">Отмена</button>
            <button id="merge-confirm" style="flex:2;padding:11px;border-radius:10px;border:none;background:#005bff;color:#fff;font-size:13px;font-weight:700;cursor:pointer">Объединить аккаунты</button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);

      dialog.querySelector('#merge-cancel')!.addEventListener('click', () => {
        dialog.remove();
        resolve();
      });

      dialog.querySelector('#merge-confirm')!.addEventListener('click', async () => {
        dialog.remove();
        const overlay = this.createOverlay('Объединяем аккаунты...');
        document.body.appendChild(overlay);
        try {
          await authService.linkYandex(token, true);
          overlay.remove();
          // Перезагружаем компании, так как могли добавиться новые
          (window as any).profileModule?.showAccountTab?.();
          // Перезагружаем страницу чтобы company switcher обновился
          setTimeout(() => location.reload(), 800);
        } catch (err) {
          overlay.remove();
          const msg = err instanceof Error ? err.message : 'Ошибка объединения';
          alert(msg);
        }
        resolve();
      });
    });
  }

  private createOverlay(text: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px';
    el.innerHTML = `
      <div style="font-size:14px;color:#fff">${text}</div>
      <div style="width:32px;height:32px;border:2px solid rgba(255,255,255,.3);border-top-color:#fc3f1d;border-radius:50%;animation:spin .8s linear infinite"></div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;
    return el;
  }

  private async handleYandexToken(token: string): Promise<void> {
    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="auth-card" style="gap:16px">
        <div class="auth-logo">SimaDesk</div>
        <div style="color:var(--text2);font-size:13px">Входим через Яндекс...</div>
        <div style="width:32px;height:32px;border:2px solid var(--border2);border-top-color:#fc3f1d;border-radius:50%;animation:spin .8s linear infinite"></div>
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;
    try {
      await authService.loginWithYandex(token);
      this.success();
    } catch (err) {
      this.render();
      setTimeout(() => {
        const msg = err instanceof Error ? err.message : 'Ошибка входа через Яндекс';
        this.showError(msg);
      }, 0);
    }
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
        <div class="auth-sub">Выберите удобный способ входа</div>

        <div class="auth-error" id="auth-error"></div>

        <div class="auth-methods">

          <!-- Telegram method -->
          <div class="auth-method">
            <div class="auth-method-header">
              <div class="auth-method-icon tg">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="#2AABEE">
                  <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.833.94z"/>
                </svg>
              </div>
              <div class="auth-method-meta">
                <div class="auth-method-name">Telegram</div>
                <span class="auth-method-badge vpn-req">⚠️ Нужен VPN в России</span>
              </div>
            </div>
            <div class="auth-tg-wrap" id="tg-widget-wrap">
              ${this.renderWidget()}
            </div>
            <div style="font-size:11px;color:var(--text3);margin-top:6px;line-height:1.5">
              Чтобы войти с другого Telegram-аккаунта — используй
              <a href="https://web.telegram.org/a/#logout" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">выход из Telegram Web</a>
              или открой в приватном режиме
            </div>
          </div>

          <!-- Yandex method -->
          ${YANDEX_CLIENT_ID ? `
          <div class="auth-method">
            <div class="auth-method-header">
              <div class="auth-method-icon ya">
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path d="M2.04 12c0-5.523 4.476-10 10-10 5.522 0 10 4.477 10 10s-4.478 10-10 10c-5.524 0-10-4.477-10-10z" fill="#FC3F1D"/>
                  <path d="M13.32 7.666h-.924c-1.694 0-2.585.858-2.585 2.123 0 1.43.616 2.1 1.881 2.959l1.045.704-3.003 4.548H7.49l2.695-4.07c-1.55-1.111-2.42-2.19-2.42-4.025 0-2.288 1.595-3.805 4.355-3.805h2.97v11.9H13.32V7.666z" fill="#fff"/>
                </svg>
              </div>
              <div class="auth-method-meta">
                <div class="auth-method-name">Яндекс ID</div>
                <span class="auth-method-badge no-vpn">✓ Работает без VPN в России</span>
              </div>
            </div>
            ${this.renderYandexBtn()}
          </div>
          ` : ''}

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

    // Yandex login
    document.getElementById('yandex-login-btn')?.addEventListener('click', () => {
      this.redirectToYandex();
    });
    document.getElementById('yandex-switch-btn')?.addEventListener('click', () => {
      this.redirectToYandex(true);
    });

    // Dev bypass
    if (IS_DEV_AUTH) {
      document.getElementById('dev-login-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        this.showError('');
        btn.disabled = true;
        btn.style.opacity = '0.5';
        try {
          await authService.devLogin();
          this.success();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Ошибка dev-входа. Смотри консоль.';
          this.showError(msg);
          btn.disabled = false;
          btn.style.opacity = '1';
        }
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
    if (!BOT_USERNAME) return '';
    return `<div id="tg-widget-inner"></div>`;
  }

  private renderYandexBtn(): string {
    if (!YANDEX_CLIENT_ID) return '';
    return `
      <button class="auth-ya-btn" id="yandex-login-btn">
        <svg class="auth-ya-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M2.04 12c0-5.523 4.476-10 10-10 5.522 0 10 4.477 10 10s-4.478 10-10 10c-5.524 0-10-4.477-10-10z" fill="#FC3F1D"/>
          <path d="M13.32 7.666h-.924c-1.694 0-2.585.858-2.585 2.123 0 1.43.616 2.1 1.881 2.959l1.045.704-3.003 4.548H7.49l2.695-4.07c-1.55-1.111-2.42-2.19-2.42-4.025 0-2.288 1.595-3.805 4.355-3.805h2.97v11.9H13.32V7.666z" fill="#fff"/>
        </svg>
        Войти через Яндекс
      </button>
      <button class="auth-switch-btn" id="yandex-switch-btn" title="Войти с другого Яндекс аккаунта">
        Сменить аккаунт Яндекс
      </button>
    `;
  }

  private redirectToYandex(forceConfirm = false): void {
    if (!YANDEX_CLIENT_ID) return;
    const redirectUri = encodeURIComponent(window.location.origin + '/');
    const force = forceConfirm ? '&force_confirm=yes' : '';
    const url = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${YANDEX_CLIENT_ID}&redirect_uri=${redirectUri}${force}`;
    window.location.href = url;
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
