import { authService } from './authService';

const API_URL = import.meta.env.VITE_API_URL as string;

/**
 * Запрос к ИИ через сервер SimaDesk (ai-proxy) → SIMA Platform.
 *
 * Раньше браузер сам ходил в OpenRouter с ключом компании, и ключ был виден
 * любому. Теперь браузер шлёт тот же запрос с пропуском человека, а ключи
 * OpenRouter живут только на сервере. Ответ — в формате OpenRouter, в том
 * числе потоковый (stream: true).
 */
export function aiFetch(body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${API_URL}/functions/v1/ai-proxy`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authService.getAccessToken() ?? ''}`,
    },
    body: JSON.stringify(body),
  });
}

/** Ключ ИИ теперь на сервере: этим значением код помечает «ИИ настроен». */
export const SERVER_AI_KEY = 'server';
