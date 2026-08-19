import { wbDb } from './wbDb';
import { ozonDb } from './ozonDb';
import { yandexDb } from './yandexDb';
import { wbApi } from './wbApi';
import { ozonApi } from './ozonApi';
import { yandexApi } from './yandexApi';
import { showToast } from '@/utils/toast';

export interface InvalidApiEntry {
  id: string;
  mp: 'wb' | 'ozon' | 'yandex';
  name: string;
}

const STORAGE_KEY = 'api_health_invalid_stores';

export function getInvalidApiStores(): InvalidApiEntry[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch { return []; }
}

function setInvalidApiStores(entries: InvalidApiEntry[]): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  window.dispatchEvent(new CustomEvent('api-health-checked', { detail: entries }));
}

function isAuthError(msg: string): boolean {
  return (
    msg.includes(' 401') || msg.includes(' 403') ||
    msg.toLowerCase().includes('unauthorized') ||
    msg.toLowerCase().includes('forbidden') ||
    msg.toLowerCase().includes('invalid token') ||
    msg.toLowerCase().includes('access denied')
  );
}

export async function runApiHealthCheck(): Promise<void> {
  const invalid: InvalidApiEntry[] = [];

  try {
    const wbStores = await wbDb.getStores();
    for (const store of wbStores) {
      try {
        await wbApi.checkToken(store.api_key);
      } catch (e: unknown) {
        if (isAuthError(e instanceof Error ? e.message : String(e))) {
          invalid.push({ id: store.id, mp: 'wb', name: store.name });
        }
      }
    }
  } catch { /* db unavailable */ }

  try {
    const ozonStores = await ozonDb.getStores();
    for (const store of ozonStores) {
      try {
        await ozonApi.checkToken({ client_id: store.client_id, api_key: store.api_key });
      } catch (e: unknown) {
        if (isAuthError(e instanceof Error ? e.message : String(e))) {
          invalid.push({ id: store.id, mp: 'ozon', name: store.name });
        }
      }
    }
  } catch { /* db unavailable */ }

  try {
    const ymStores = await yandexDb.getStores();
    for (const store of ymStores) {
      try {
        await yandexApi.checkToken(store.api_key);
      } catch (e: unknown) {
        if (isAuthError(e instanceof Error ? e.message : String(e))) {
          invalid.push({ id: store.id, mp: 'yandex', name: store.name });
        }
      }
    }
  } catch { /* db unavailable */ }

  setInvalidApiStores(invalid);

  for (const entry of invalid) {
    const mpName = entry.mp === 'wb' ? 'Wildberries' : entry.mp === 'ozon' ? 'Ozon' : 'Яндекс Маркет';
    showToast(`⚠ API-ключ «${entry.name}» (${mpName}) недействителен`, 'warning', 7000);
    await new Promise(r => setTimeout(r, 600));
  }
}
