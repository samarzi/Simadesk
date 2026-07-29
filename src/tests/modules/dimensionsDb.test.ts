import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/dbClient', () => ({
  dbFetch: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/services/companyService', () => ({
  companyService: { getActiveId: vi.fn().mockReturnValue('company-1') },
}));

import { dimensionsDb } from '@/services/dimensionsDb';
import { dbFetch } from '@/services/dbClient';
import { companyService } from '@/services/companyService';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(companyService.getActiveId).mockReturnValue('company-1');
  vi.mocked(dbFetch).mockResolvedValue([]);
});

describe('dimensionsDb — local cache', () => {
  it('returns null for unknown vendor code', () => {
    expect(dimensionsDb.get('UNKNOWN')).toBeNull();
  });

  it('set() stores and get() retrieves entry', () => {
    dimensionsDb.set('ART-1', { weight_g: 500, length_mm: 100, width_mm: 50, height_mm: 30 });
    const result = dimensionsDb.get('ART-1');
    expect(result).not.toBeNull();
    expect(result?.weight_g).toBe(500);
    expect(result?.length_mm).toBe(100);
  });

  it('get() is case-insensitive', () => {
    dimensionsDb.set('Art-One', { weight_g: 200, length_mm: 80, width_mm: 40, height_mm: 20 });
    expect(dimensionsDb.get('ART-ONE')).not.toBeNull();
    expect(dimensionsDb.get('art-one')).not.toBeNull();
  });

  it('setMany() stores multiple entries at once', () => {
    dimensionsDb.setMany([
      { vendorCode: 'SKU-A', dims: { weight_g: 100, length_mm: 10, width_mm: 10, height_mm: 10 } },
      { vendorCode: 'SKU-B', dims: { weight_g: 200, length_mm: 20, width_mm: 20, height_mm: 20 } },
    ]);
    expect(dimensionsDb.get('SKU-A')?.weight_g).toBe(100);
    expect(dimensionsDb.get('SKU-B')?.weight_g).toBe(200);
  });

  it('remove() deletes an entry', () => {
    dimensionsDb.set('REMOVE-ME', { weight_g: 1, length_mm: 1, width_mm: 1, height_mm: 1 });
    expect(dimensionsDb.get('REMOVE-ME')).not.toBeNull();
    dimensionsDb.remove('REMOVE-ME');
    expect(dimensionsDb.get('REMOVE-ME')).toBeNull();
  });

  it('all() returns all stored entries', () => {
    dimensionsDb.clear();
    dimensionsDb.setMany([
      { vendorCode: 'X1', dims: { weight_g: 10, length_mm: null, width_mm: null, height_mm: null } },
      { vendorCode: 'X2', dims: { weight_g: 20, length_mm: null, width_mm: null, height_mm: null } },
    ]);
    expect(dimensionsDb.all()).toHaveLength(2);
  });

  it('clear() empties the store', () => {
    dimensionsDb.set('KEEP', { weight_g: 1, length_mm: 1, width_mm: 1, height_mm: 1 });
    dimensionsDb.clear();
    expect(dimensionsDb.all()).toHaveLength(0);
  });
});

describe('dimensionsDb — Supabase sync', () => {
  it('set() fires a POST to product_dimensions', async () => {
    dimensionsDb.set('SYNC-1', { weight_g: 300, length_mm: 60, width_mm: 30, height_mm: 15 });
    await vi.waitFor(() => expect(dbFetch).toHaveBeenCalled());
    const [endpoint, opts] = vi.mocked(dbFetch).mock.calls[0];
    expect(endpoint).toBe('product_dimensions');
    expect((opts as RequestInit).method).toBe('POST');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.vendor_code).toBe('SYNC-1');
    expect(body.weight_g).toBe(300);
    expect(body.company_id).toBe('company-1');
  });

  it('setMany() fires one batch POST for all entries', async () => {
    vi.clearAllMocks();
    dimensionsDb.setMany([
      { vendorCode: 'B1', dims: { weight_g: 50, length_mm: null, width_mm: null, height_mm: null } },
      { vendorCode: 'B2', dims: { weight_g: 60, length_mm: null, width_mm: null, height_mm: null } },
    ]);
    await vi.waitFor(() => expect(dbFetch).toHaveBeenCalled());
    expect(vi.mocked(dbFetch).mock.calls.length).toBe(1);
    const body = JSON.parse((vi.mocked(dbFetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toHaveLength(2);
  });

  it('remove() fires DELETE with correct query params', async () => {
    dimensionsDb.set('DEL-1', { weight_g: 1, length_mm: 1, width_mm: 1, height_mm: 1 });
    vi.clearAllMocks();
    dimensionsDb.remove('DEL-1');
    await vi.waitFor(() => expect(dbFetch).toHaveBeenCalled());
    const [endpoint, opts] = vi.mocked(dbFetch).mock.calls[0];
    expect(String(endpoint)).toContain('product_dimensions');
    expect((opts as RequestInit).method).toBe('DELETE');
  });

  it('set() skips Supabase sync when no active company', async () => {
    vi.mocked(companyService.getActiveId).mockReturnValue(null);
    vi.clearAllMocks();
    dimensionsDb.set('NO-COMPANY', { weight_g: 1, length_mm: 1, width_mm: 1, height_mm: 1 });
    await new Promise(r => setTimeout(r, 20));
    expect(dbFetch).not.toHaveBeenCalled();
  });

  it('syncFromDb() merges server rows into local cache, keeping newer entries', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 60_000).toISOString();

    dimensionsDb.set('MERGE-1', { weight_g: 999, length_mm: null, width_mm: null, height_mm: null });

    vi.mocked(dbFetch).mockResolvedValueOnce([
      { vendor_code: 'MERGE-1', company_id: 'company-1', weight_g: 100, length_mm: null, width_mm: null, height_mm: null, updated_at: old },
      { vendor_code: 'MERGE-2', company_id: 'company-1', weight_g: 200, length_mm: null, width_mm: null, height_mm: null, updated_at: now },
    ]);

    await dimensionsDb.syncFromDb();

    // MERGE-1: local is newer — keep weight_g=999
    expect(dimensionsDb.get('MERGE-1')?.weight_g).toBe(999);
    // MERGE-2: from server
    expect(dimensionsDb.get('MERGE-2')?.weight_g).toBe(200);
  });

  it('syncFromDb() skips when no active company', async () => {
    vi.mocked(companyService.getActiveId).mockReturnValue(null);
    vi.clearAllMocks();
    await dimensionsDb.syncFromDb();
    expect(dbFetch).not.toHaveBeenCalled();
  });
});
