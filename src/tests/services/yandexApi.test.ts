import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchAllYandexOrders } from '@/services/yandexApi';
import type { YandexStore } from '@/types/yandex';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const store = { id: 's1', name: 'Test', api_key: 'k', campaign_id: 123 } as unknown as YandexStore;

/** Собирает toDate из каждого запроса к /orders. */
function requestedRanges(): Array<{ from: string; to: string }> {
  return mockFetch.mock.calls.map(([url]) => {
    const qs = new URL(String(url), 'http://x').searchParams;
    return { from: qs.get('fromDate')!, to: qs.get('toDate')! };
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ orders: [], paging: {} }),
  });
});

describe('fetchAllYandexOrders — граница диапазона дат', () => {
  it('запрашивает toDate на день позже указанного (ЯМ трактует его как исключительный)', async () => {
    await fetchAllYandexOrders(store, '13-08-2026', '20-08-2026');

    const ranges = requestedRanges();
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe('13-08-2026');
    // без сдвига ЯМ вернул бы заказы только по 19-08 — заказы «за сегодня» терялись
    expect(ranges[0].to).toBe('21-08-2026');
  });

  it('запрашивает заказы за один день, когда fromDate === toDate', async () => {
    await fetchAllYandexOrders(store, '20-08-2026', '20-08-2026');

    const ranges = requestedRanges();
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ from: '20-08-2026', to: '21-08-2026' });
  });

  it('покрывает последний день месяца при помесячной синхронизации', async () => {
    await fetchAllYandexOrders(store, '01-07-2026', '31-07-2026');

    const ranges = requestedRanges();
    expect(ranges[ranges.length - 1].to).toBe('01-08-2026');
  });

  it('разбивает длинный период на чанки, не теряя последний день', async () => {
    await fetchAllYandexOrders(store, '01-06-2026', '20-08-2026');

    const ranges = requestedRanges();
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[0].from).toBe('01-06-2026');
    expect(ranges[ranges.length - 1].to).toBe('21-08-2026');
  });
});
