// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openAiModelPicker } from '@/components/aiModelPicker';
import { selectedAiModel } from '@/services/aiModels';

vi.mock('@/services/authService', () => ({ authService: { getUser: () => ({ id: 'test' }), getAccessToken: () => 'test-token' } }));
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
afterEach(() => { document.querySelector('dialog')?.close(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

it('keeps Auto selectable when the catalog request fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Сеть недоступна' }), { status: 502 })));
  openAiModelPicker('quality');
  await vi.waitFor(() => expect(document.querySelector('[role=status]')?.textContent).toContain('Сеть недоступна'));
  (document.querySelector('[data-select-auto]') as HTMLButtonElement).click();
  expect(selectedAiModel('quality')).toBe('auto');
  expect(document.querySelector('dialog')).toBeNull();
});

it('searches and selects a photo model without changing the assistant model', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
    { id: 'sample/vision:free', name: 'Sample Vision', is_free: true, architecture: { input_modalities: ['text','image'], output_modalities: ['text'] } },
    { id: 'sample/vision-paid', name: 'Sample Vision Paid', pricing: { prompt: '0.000002', completion: '0.000008' }, architecture: { input_modalities: ['text','image'], output_modalities: ['text'] } },
    { id: 'sample/text:free', name: 'Sample Text', is_free: true, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ] }))));
  openAiModelPicker('rights', { vision: true });
  await vi.waitFor(() => expect(document.querySelectorAll('[data-select-model]')).toHaveLength(1));
  const tier = document.querySelector('[data-tier]') as HTMLSelectElement;
  tier.value = 'paid'; tier.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelectorAll('[data-select-model]')).toHaveLength(1));
  expect(document.querySelector('.sd-model-tags')?.textContent).toContain('$2 / 1 млн вход');
  tier.value = 'free'; tier.dispatchEvent(new Event('change', { bubbles: true }));
  const search = document.querySelector('input[type=search]') as HTMLInputElement;
  search.value = 'vision'; search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(document.querySelectorAll('[data-select-model]')).toHaveLength(1);
  (document.querySelector('[data-select-model]') as HTMLButtonElement).click();
  expect(selectedAiModel('rights')).toBe('sample/vision:free');
  expect(selectedAiModel('assistant')).toBe('auto');
});
