// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { IpAudit } from '@/modules/ipAudit';
import { dbFetch } from '@/services/dbClient';
import { analysisAiFetch } from '@/services/aiProxy';
import { loadAiCatalog } from '@/services/aiModels';

vi.mock('@/services/dbClient', () => ({ dbFetch: vi.fn(), dbFetchAll: vi.fn().mockResolvedValue([]) }));
vi.mock('@/services/aiProxy', () => ({ analysisAiFetch: vi.fn() }));
vi.mock('@/services/companyService', () => ({ companyService: { getActiveId: () => 'company1' } }));
vi.mock('@/services/aiTokenQuota', () => ({ hasQuota: () => true, recordAiSpend: vi.fn() }));
vi.mock('@/services/aiUsage', () => ({ reportAiUsage: () => null }));
vi.mock('@/modules/analytics/services/exporter', () => ({ exportXlsx: vi.fn(), exportFileName: vi.fn() }));
vi.mock('@/services/aiModels', async importOriginal => ({ ...await importOriginal<typeof import('@/services/aiModels')>(), loadAiCatalog: vi.fn().mockRejectedValue(new Error('offline')) }));

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); vi.stubGlobal('crypto', webcrypto);
  vi.mocked(dbFetch).mockImplementation(async (path, options) => {
    const data = JSON.parse(String(options?.body ?? '{}'));
    if (path === 'ip_audit_runs') return [{ id: 'run1', status: 'running', processed: 0, errors: 0, created_at: new Date().toISOString(), ...data }] as any;
    if (path.startsWith('ip_audit_findings?on_conflict')) return [{ id: 'finding1', ...data }] as any;
    return [] as any;
  });
  vi.mocked(analysisAiFetch).mockResolvedValue(new Response(JSON.stringify({ model: 'actual/free:free', choices: [{ message: { content: JSON.stringify({ risk: 'low', reason: 'Упоминание в названии', object_name: 'Пример' }) } }] })));
});

it('runs Auto without loading a catalog, respects selected stores and prevents duplicate starts', async () => {
  const cards = [1,2].map(i => ({ uid: `c${i}`, mp: 'wb' as const, storeId: `s${i}`, storeName: `Store ${i}`, vendorCode: `A${i}`, name: 'Товар с упоминанием объекта', photoUrls: [] }));
  const audit = new IpAudit(() => cards, async () => 'Описание товара', vi.fn());
  await audit.load(); audit.toggleStore('s2');
  const running = audit.start('sample');
  await audit.start('sample'); await running;
  expect(loadAiCatalog).not.toHaveBeenCalled();
  expect(analysisAiFetch).toHaveBeenCalledOnce();
  const request = vi.mocked(analysisAiFetch).mock.calls[0][0] as any;
  expect(request.model).toBe('auto');
  expect(request.messages[0].content[0].text).toContain('Описание товара');
  const runs = vi.mocked(dbFetch).mock.calls.filter(([path]) => path === 'ip_audit_runs');
  expect(runs).toHaveLength(1);
  expect(JSON.parse(String(runs[0][1]?.body))).toMatchObject({ total: 1, product_keys: ['c1'], model_id: 'auto' });
  expect(audit.findings[0].details.actual_model).toBe('actual/free:free');
  expect(audit.runs[0].status).toBe('completed');
});
