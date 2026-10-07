import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordAiSpend, getQuotaInfo, hasQuota, estimateCostUsd, modelLimitMultiplier,
  BASE_USD_PER_TOKEN, FREE_DAILY_TOKENS,
} from '@/services/aiTokenQuota';

const today = () => new Date().toISOString().slice(0, 10);

function cacheModels(list: Array<{ id: string; prompt: string; completion: string }>) {
  localStorage.setItem('sd_or_models_v2', JSON.stringify({
    ts: 0, // устаревший кеш: цены всё равно годятся
    data: list.map(m => ({ id: m.id, name: m.id, pricing: { prompt: m.prompt, completion: m.completion } })),
  }));
}

describe('aiTokenQuota — лимит по стоимости', () => {
  beforeEach(() => {
    localStorage.clear();
    cacheModels([
      { id: 'anthropic/claude-haiku-4.5', prompt: '0.000001', completion: '0.000005' },
      { id: 'anthropic/claude-opus-5', prompt: '0.000005', completion: '0.000025' },
      { id: 'deepseek/deepseek-chat-v3.1', prompt: '0.00000025', completion: '0.00000095' },
    ]);
  });

  it('записывает реальные токены и стоимость от OpenRouter', () => {
    recordAiSpend({ prompt: 9000, completion: 1000, total: 10_000, cost: 0.02 }, 'anthropic/claude-opus-5');
    const q = getQuotaInfo();
    expect(q.tokens).toBe(10_000);
    expect(q.costUsd).toBeCloseTo(0.02);
  });

  it('без cost от провайдера считает стоимость по прайсу модели', () => {
    expect(estimateCostUsd('anthropic/claude-opus-5', 1_000_000, 0)).toBeCloseTo(5);
    // «4-5» и «4.5» — одна модель
    expect(estimateCostUsd('anthropic/claude-haiku-4-5', 1_000_000, 0)).toBeCloseTo(1);
  });

  it('дорогая модель расходует лимит быстрее дешёвой при тех же токенах', () => {
    const usage = { prompt: 19_400, completion: 600, total: 20_000 };
    recordAiSpend(usage, 'anthropic/claude-opus-5');
    const opus = getQuotaInfo();
    localStorage.removeItem('sd_ai_cost_' + today());
    localStorage.removeItem('sd_ai_daily_' + today());
    recordAiSpend(usage, 'deepseek/deepseek-chat-v3.1');
    const ds = getQuotaInfo();
    expect(opus.tokens).toBe(ds.tokens);
    expect(opus.costUsd).toBeGreaterThan(ds.costUsd * 10);
    // один запрос Opus в 20К токенов съедает весь бесплатный день, DeepSeek — ~10%
    expect(opus.exhausted).toBe(true);
    expect(ds.pct).toBeLessThan(15);
    expect(modelLimitMultiplier('anthropic/claude-opus-5')).toBeCloseTo(5);
  });

  it('бесплатный бюджет = 50К токенов базовой модели', () => {
    recordAiSpend({ prompt: 0, completion: 0, total: 0, cost: FREE_DAILY_TOKENS * BASE_USD_PER_TOKEN * 0.99 }, 'x');
    expect(hasQuota()).toBe(true);
    recordAiSpend({ prompt: 0, completion: 0, total: 0, cost: FREE_DAILY_TOKENS * BASE_USD_PER_TOKEN * 0.02 }, 'x');
    expect(hasQuota()).toBe(false);
  });

  it('расход, записанный до перехода на стоимость, не обнуляется', () => {
    localStorage.setItem('sd_ai_daily_' + today(), String(FREE_DAILY_TOKENS));
    expect(hasQuota()).toBe(false);
  });
});
