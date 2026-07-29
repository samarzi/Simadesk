/**
 * Утилита для работы с куки-файлами.
 *
 * Куки — это небольшие текстовые файлы, которые браузер сохраняет на устройстве пользователя.
 * В отличие от localStorage (который стирается при очистке данных браузера или в режиме
 * инкогнито), куки имеют явный срок жизни и сохраняются надёжнее.
 *
 * В этом проекте куки используются как РЕЗЕРВНАЯ копия сессии:
 * если localStorage пуст (очищен), браузер восстановит сессию из куки — пользователь
 * останется залогиненным и не потеряет выбранную компанию.
 */

const DEFAULT_MAX_AGE = 90 * 24 * 60 * 60; // 90 дней в секундах

export const cookies = {
  set(name: string, value: string, maxAgeSec = DEFAULT_MAX_AGE): void {
    const secure = location.protocol === 'https:' ? ';Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)};max-age=${maxAgeSec};path=/;SameSite=Lax${secure}`;
  },

  get(name: string): string | null {
    const match = document.cookie.split('; ').find(r => r.startsWith(`${name}=`));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
  },

  remove(name: string): void {
    document.cookie = `${name}=;max-age=0;path=/`;
  },
};
