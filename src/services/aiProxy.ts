import { authService } from './authService';
import { selectedAiModel, type AiScope } from './aiModels';

const API_URL = import.meta.env.VITE_API_URL as string;

/**
 * Запрос к ИИ через сервер SimaDesk (ai-proxy) → SIMA Platform.
 *
 * Раньше браузер сам ходил в OpenRouter с ключом компании, и ключ был виден
 * любому. Теперь браузер шлёт тот же запрос с пропуском человека, а ключи
 * OpenRouter живут только на сервере. Ответ — в формате OpenRouter, в том
 * числе потоковый (stream: true).
 */
export async function aiFetch(body: unknown, signal?: AbortSignal, scope: AiScope = 'assistant'): Promise<Response> {
  const payload = { model: selectedAiModel(scope), ...(body as Record<string, unknown>) };
  const res = await fetch(`${API_URL || ''}/functions/v1/ai-proxy`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authService.getAccessToken() ?? ''}`,
    },
    body: JSON.stringify(payload),
  });
  const model = res.headers.get('x-sima-model');
  if (res.ok && model) window.dispatchEvent(new CustomEvent('sd_ai_model_used', { detail: { scope, model } }));
  return res;
}

/** Analysis использует точно выбранную модель; использует тот же endpoint, что и aiFetch. */
export function analysisAiFetch(body: unknown, signal?: AbortSignal, scope: 'quality' | 'rights' = 'quality'): Promise<Response> {
  return aiFetch(body, signal, scope);
}

/** Правка общего «разума» Симы: характер и «обо мне» (общие для всех продуктов SIMA). */
export async function simaMindPatch(patch: { character_add?: string; character_remove?: number[]; about_add?: string }): Promise<boolean> {
  const res = await fetch(`${API_URL}/functions/v1/sima-mind`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authService.getAccessToken() ?? ''}`,
    },
    body: JSON.stringify(patch),
  }).catch(() => null);
  return Boolean(res?.ok);
}

/** Ключ ИИ теперь на сервере: этим значением код помечает «ИИ настроен». */
export const SERVER_AI_KEY = 'server';
