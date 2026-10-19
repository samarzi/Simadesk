// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { IpAudit } from '@/modules/ipAudit';
import { dbFetch, dbFetchAll } from '@/services/dbClient';
import { analysisAiFetch } from '@/services/aiProxy';
import { loadAiCatalog, setAiModel } from '@/services/aiModels';

vi.mock('@/services/dbClient', () => ({ dbFetch: vi.fn(), dbFetchAll: vi.fn().mockImplementation(async () => []) }));
vi.mock('@/services/aiProxy', () => ({ analysisAiFetch: vi.fn() }));
vi.mock('@/services/companyService', () => ({ companyService: { getActiveId: () => 'company1' } }));
vi.mock('@/services/aiTokenQuota', () => ({ hasQuota: () => true, recordAiSpend: vi.fn(), isFreeAiModel: (id: string) => id.endsWith(':free') }));
vi.mock('@/services/aiUsage', () => ({ reportAiUsage: () => null }));
vi.mock('@/modules/analytics/services/exporter', () => ({ exportXlsx: vi.fn(), exportFileName: vi.fn() }));
vi.mock('@/services/aiModels', async importOriginal => ({ ...await importOriginal<typeof import('@/services/aiModels')>(), loadAiCatalog: vi.fn().mockRejectedValue(new Error('offline')) }));

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); vi.stubGlobal('crypto', webcrypto);
  vi.mocked(dbFetch).mockImplementation(async (path, options) => {
    const data = JSON.parse(String(options?.body ?? '{}'));
    if (path === 'ip_audit_runs' || path.startsWith('ip_audit_runs?company_id=')) return [{ id: 'run1', company_id: 'company1', status: 'running', scope: 'sample', total: 1, processed: 0, errors: 0, created_at: new Date().toISOString(), model_id: 'auto', ...data }] as any;
    if (path.startsWith('ip_audit_findings?on_conflict')) return [{ id: 'finding1', ...data }] as any;
    return [] as any;
  });
  vi.mocked(analysisAiFetch).mockResolvedValue(new Response(JSON.stringify({ model: 'actual/free:free', choices: [{ message: { content: JSON.stringify({ risk: 'insufficient', reason: 'Нет фото', object_name: 'Пример', details: { audit_version: 'ru-photo-v3' } }) } }] })));
});

it('respects selected stores, avoids duplicate starts and does not send cards without photos to AI', async () => {
  const cards = [1,2].map(i => ({ uid: `c${i}`, mp: 'wb' as const, storeId: `s${i}`, storeName: `Store ${i}`, vendorCode: `A${i}`, name: 'Товар с упоминанием объекта', photoUrls: [] }));
  const audit = new IpAudit(() => cards, async () => 'Описание товара', vi.fn());
  await audit.load(); audit.toggleStore('s2');
  const running = audit.start('sample');
  await audit.start('sample'); await running;
  expect(loadAiCatalog).not.toHaveBeenCalled();
  expect(analysisAiFetch).not.toHaveBeenCalled();
  const runs = vi.mocked(dbFetch).mock.calls.filter(([path]) => path === 'ip_audit_runs');
  expect(runs).toHaveLength(1);
  expect(JSON.parse(String(runs[0][1]?.body))).toMatchObject({ total: 1, product_keys: ['c1'], model_id: 'auto' });
  expect(audit.findings[0].risk).toBe('insufficient');
  expect(audit.findings[0].error).toContain('Нет фото для анализа');
  expect(audit.runs[0].status).toBe('paused');
});

it('still analyses the photo if fetching the marketplace description fails', async () => {
  const card = { uid: 'c1', mp: 'wb' as const, storeId: 's1', storeName: 'Store', vendorCode: 'A1', name: 'Футболка', photoUrls: ['https://basket-45.wbbasket.ru/photo.webp'] };
  const audit = new IpAudit(() => [card], async () => { throw new Error('Marketplace unavailable'); }, vi.fn());
  await audit.load(); await audit.start('sample');
  expect(analysisAiFetch).toHaveBeenCalledOnce();
  expect(audit.findings).toHaveLength(1);
  expect(audit.findings[0].error).toContain('Marketplace unavailable');
  expect(audit.findings[0].details.description_error).toContain('Описание');
  expect(audit.runs[0].errors).toBe(1);
  expect(audit.message).toContain('Продолжить');
});

it('tries free vision providers beyond the previous five-model cutoff', async () => {
  const models = Array.from({ length: 6 }, (_, i) => ({
    id: `provider${i}/vision:free`, name: `Vision ${i}`, free: true,
    context: 100_000 - i, input: ['text', 'image'], output: ['text'], parameters: [],
    description: '', maxOutput: null, created: null, knowledgeCutoff: null,
    expiration: null, tokenizer: null, instructType: null, moderated: null,
  }));
  vi.mocked(loadAiCatalog).mockResolvedValue({ models, auto: { vision: models[0].id } });
  let modelAttempt = 0;
  vi.mocked(analysisAiFetch).mockImplementation(async body => {
    const attempt = ++modelAttempt;
    const risk = attempt < 6 ? 'insufficient' : 'none';
    return new Response(JSON.stringify({ model: models[attempt - 1]?.id, choices: [{ message: { content: JSON.stringify({
      risk, reason: risk === 'none' ? 'Фото проверено' : 'Повторить', object_name: '',
      details: { audit_version: 'ru-photo-v5', actual_models: [models[attempt - 1]?.id] },
    }) } }] }));
  });
  const card = { uid: 'c1', mp: 'wb' as const, storeId: 's1', storeName: 'Store', vendorCode: 'A1', name: 'Футболка', photoUrls: ['https://basket-45.wbbasket.ru/photo.webp'] };
  const audit = new IpAudit(() => [card], async () => 'Описание товара', vi.fn());
  await audit.load();
  await audit.start('sample');
  expect(analysisAiFetch).toHaveBeenCalledTimes(6);
  expect(audit.findings[0].risk).toBe('none');
  expect(audit.runs[0].status).toBe('completed');
});

it('applies the currently selected paid vision model when resuming an older run', async () => {
  const card = { uid: 'c1', mp: 'wb' as const, storeId: 's1', storeName: 'Store', vendorCode: 'A1', name: 'Футболка', photoUrls: ['https://basket-45.wbbasket.ru/photo.webp'] };
  const pausedRun = { id: 'run1', company_id: 'company1', status: 'paused', scope: 'sample', total: 1, processed: 0, errors: 1,
    created_at: new Date().toISOString(), model_id: 'old/free:free', product_keys: ['c1'] };
  vi.mocked(dbFetch).mockImplementation(async (path, options) => {
    if (path.startsWith('ip_audit_runs?company_id=')) return [{ ...pausedRun, product_keys: undefined }] as any;
    if (path.startsWith('ip_audit_runs?id=eq.run1')) return [pausedRun] as any;
    const data = JSON.parse(String(options?.body ?? '{}'));
    if (path.startsWith('ip_audit_findings?on_conflict')) return [{ id: 'finding1', ...data }] as any;
    return [] as any;
  });
  vi.mocked(loadAiCatalog).mockResolvedValue({ models: [{ id: 'paid/vision', name: 'Paid Vision', free: false, context: 100_000,
    input: ['text', 'image'], output: ['text'], parameters: [], description: '', maxOutput: 4000, created: null,
    knowledgeCutoff: null, expiration: null, tokenizer: null, instructType: null, moderated: null }], auto: {} });
  setAiModel('rights', 'paid/vision');
  vi.mocked(analysisAiFetch).mockResolvedValue(new Response(JSON.stringify({ model: 'paid/vision', usage: { total_tokens: 12 }, choices: [{ message: { content: JSON.stringify({
    risk: 'none', reason: 'Проверено', details: { audit_version: 'ru-photo-v5', actual_models: ['paid/vision'] },
  }) } }] })));
  const audit = new IpAudit(() => [card], async () => 'Описание товара', vi.fn());
  await audit.load();
  await audit.resume('run1');
  expect(analysisAiFetch).toHaveBeenCalledOnce();
  expect(vi.mocked(analysisAiFetch).mock.calls[0][0]).toMatchObject({ model: 'paid/vision' });
  expect(vi.mocked(dbFetch).mock.calls.some(([path, options]) => path === 'ip_audit_runs?id=eq.run1' &&
    JSON.parse(String(options?.body)).model_id === 'paid/vision')).toBe(true);
  expect(audit.runs[0].model_id).toBe('paid/vision');
});

it('loads run metadata and references first, then loads the selected findings page on demand', async () => {
  const audit = new IpAudit(() => [], async () => '', vi.fn());
  const firstLoad = audit.load();
  expect(audit.loading).toBe(true);
  await firstLoad;
  await audit.load();
  expect(audit.loading).toBe(false);
  expect(dbFetchAll).toHaveBeenCalledOnce();
  const queries = vi.mocked(dbFetchAll).mock.calls.map(([path]) => String(path));
  expect(queries.some(path => path.includes('ip_audit_references?company_id=eq.company1'))).toBe(true);
  const initialQueries = vi.mocked(dbFetch).mock.calls.map(([path]) => String(path));
  expect(initialQueries.some(path => path.includes('ip_audit_runs?company_id=eq.company1') && !path.includes('product_keys'))).toBe(true);
  expect(initialQueries.some(path => path.includes('ip_audit_findings'))).toBe(false);
  audit.setSection('results');
  expect(vi.mocked(dbFetch).mock.calls.some(([path]) => String(path).includes('ip_audit_findings') && String(path).endsWith('limit=100'))).toBe(true);
});
