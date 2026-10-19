// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filterAiModels, modelCompatible, normalizeCatalog, selectedAiModel, setAiModel } from '@/services/aiModels';

const catalog = normalizeCatalog({ data: [
  { id: 'provider/vision:free', name: 'Vision One', is_free: true, description: 'Распознаёт логотипы', context_length: 128000, architecture: { input_modalities: ['text','image'], output_modalities: ['text'] }, supported_parameters: ['reasoning','tools'], pricing: { prompt: '9' } },
  { id: 'other/text', name: 'Text Two', architecture: { modality: 'text->text' }, context_length: 64000 },
  { id: 'other/image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
] });

beforeEach(() => localStorage.clear());
describe('shared model preferences', () => {
  it('starts every tool in Auto and ignores stale paid defaults', () => {
    localStorage.setItem('sd_ai_model', 'old/paid');
    localStorage.setItem('sd_user_ai_model', 'old/paid');
    for (const scope of ['assistant','quality','rights','support','news','memory','prompt','reviews','storefront'] as const)
      expect(selectedAiModel(scope)).toBe('auto');
  });
  it('keeps quality and rights preferences independent and announces changes', () => {
    const listener = vi.fn(); window.addEventListener('sd_ai_model_changed', listener);
    setAiModel('rights', 'provider/vision:free');
    expect(selectedAiModel('rights')).toBe('provider/vision:free');
    expect(selectedAiModel('quality')).toBe('auto');
    expect(listener).toHaveBeenCalledOnce(); window.removeEventListener('sd_ai_model_changed', listener);
  });
});
describe('OpenRouter catalog', () => {
  it('searches descriptions, developer IDs and names with combined filters', () => {
    expect(filterAiModels(catalog.models, 'ЛОГОТИПЫ', { free: true, vision: true, tools: true })).toHaveLength(1);
    expect(filterAiModels(catalog.models, 'other', { free: true })).toHaveLength(0);
    expect(filterAiModels(catalog.models, 'text two')).toHaveLength(1);
  });
  it('rejects image generators and text-only models for photo audits', () => {
    expect(modelCompatible(catalog.models[0], { vision: true })).toBe(true);
    expect(modelCompatible(catalog.models[1], { vision: true })).toBe(false);
    expect(modelCompatible(catalog.models[2])).toBe(false);
  });
  it('does not retain price data or invent metadata', () => {
    expect(catalog.models[0]).not.toHaveProperty('pricing');
    expect(catalog.models[1].maxOutput).toBeNull();
    expect(catalog.models[1].input).toEqual(['text']);
  });
});
