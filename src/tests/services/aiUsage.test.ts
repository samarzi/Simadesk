// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { reportAiUsage, resetSessionUsage } from '@/services/aiUsage';

beforeEach(() => {
  document.body.innerHTML = '';
  sessionStorage.clear();
  resetSessionUsage();
  vi.stubGlobal('__sdAdminUser', false);
});

it('shows the actual model identifier in the token usage notification', () => {
  reportAiUsage('Анализ прав', { model: 'provider/paid-vision', usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } });
  expect(document.querySelector('.sd-ai-usage-model')?.textContent).toBe('Модель: provider/paid-vision');
});
